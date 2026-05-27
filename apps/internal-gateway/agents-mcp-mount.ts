/**
 * AJS-56 / AJS-57 internal-gateway integration: HTTP tool surface for
 * `agents.send_message`, JWT-verified, scope-enforced, Matrix-routed.
 *
 * Mounts when `AGENTS_MCP_JWT_SIGNING_KEY` is set in env. Exposes:
 *
 *   POST /api/agents/send_message     -- tool dispatch (JWT-bearer)
 *   POST /api/agents/admin/mint       -- dev/dogfood JWT mint (admin token)
 *
 * The `/admin/mint` endpoint is a deliberate v1 stub for the AJS-55
 * challenge-signing layer that's not implemented yet. Operators
 * enable it only in environments where they can secure a separate
 * `AGENTS_MCP_ADMIN_TOKEN`; production paths gate behind future
 * AJS-55 ed25519 challenge verification.
 *
 * Matrix substrate is a subprocess wrapper around the same send-matrix
 * adapter used for AJS-59 (`--as <identity> --stdin`). Identity is
 * server-resolved from the JWT `sub` claim; the script's existing
 * per-identity gopass resolution does the rest.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { HTTP_STATUS } from "@agents-js/a2a";
import {
  type AgentInboxTool,
  type AgentsDispatcher,
  type AuthenticatedIdentity,
  type ChallengeMintStore,
  createAgentsDispatcher,
  createChallengeMintStore,
  createIpRateLimiter,
  extractBearerToken,
  type GetMessagesArgs,
  type GetMessagesResult,
  type InboxDeliverArgs,
  type InboxDeliverResult,
  type InboxKind,
  type InboxMessage,
  type InboxReadArgs,
  type IpRateLimiter,
  type MatrixOriginEnvelope,
  type MatrixSendArgs,
  type MatrixSendResult,
  type MatrixTool,
  normalizeInboxKind,
  type PeerKeyDirectory,
  type ReloadableTrustManifest,
  redeemMintChallenge,
  type SendMessageArgs,
  type SendMessageResult,
  type TargetDirectory,
  verifyJwt,
  watchTrustManifest,
} from "@agents-js/host";
import { SignJWT } from "jose";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/**
 * Env-var contract for the agents-mcp mount. See README env table.
 */
export interface AgentsMcpEnvConfig {
  signingKey: Uint8Array;
  issuer: string;
  audience: string;
  sendScript: string;
  /**
   * Optional path to the `agent-msg` CLI binary. When set, the
   * AgentInboxProvider is enabled (subprocess wrapper around
   * `agent-msg send / agent-msg read --json`). When unset, the
   * `agents.send_message` dispatcher will reject inbox-routed targets
   * with `send-failed` and `agents.get_messages` returns `read-failed`.
   */
  agentMsgBin?: string;
  targets: Readonly<Record<string, { matrix?: { room: string }; inbox?: { session: string } }>>;
  adminToken?: string;
  jwtTtlSeconds: number;
  /**
   * AJS-55 trust manifest path (typically `/etc/agents-js/trust.json`).
   * When set, the gateway loads + watches the manifest at startup,
   * which enables `POST /api/agents/mint/challenge` + `/redeem`.
   * When unset, mint endpoints return 503 (substrate not configured).
   */
  trustManifestPath?: string;
  /** AJS-55 trust-root pubkey path (typically `/etc/agents-js/trust-root.pub`). Required if trustManifestPath is set. */
  trustRootPath?: string;
  /**
   * AJS-55 challenge rate-limit spec: `<rate>/<window>:<burst>` (e.g. `30/min:10`).
   * Currently `<window>` is `min` only; `<rate>` is requests per window;
   * `<burst>` is initial bucket size. Defaults to `30/min:10` when
   * trustManifestPath is set.
   */
  challengeRateLimit?: { ratePerMinute: number; burst: number };
}

/**
 * Parse the env for agents-mcp mount config. Returns `null` when the
 * feature gate (`AGENTS_MCP_JWT_SIGNING_KEY`) is unset. Throws on
 * misconfiguration so the gateway fails fast at startup.
 */
export function readAgentsMcpEnv(
  env: Record<string, string | undefined> = Bun.env,
): AgentsMcpEnvConfig | null {
  const signingKeyText = env.AGENTS_MCP_JWT_SIGNING_KEY;
  if (!signingKeyText) return null;
  if (signingKeyText.length < 32) {
    throw new Error(
      "[agents-mcp-mount] AGENTS_MCP_JWT_SIGNING_KEY must be at least 32 bytes (HS256 minimum)",
    );
  }
  const issuer = env.AGENTS_MCP_JWT_ISSUER;
  if (!issuer) {
    throw new Error(
      "[agents-mcp-mount] AGENTS_MCP_JWT_SIGNING_KEY is set but AGENTS_MCP_JWT_ISSUER is not",
    );
  }
  const sendScript = env.AGENTS_MCP_SEND_SCRIPT;
  if (!sendScript) {
    throw new Error(
      "[agents-mcp-mount] AGENTS_MCP_JWT_SIGNING_KEY is set but AGENTS_MCP_SEND_SCRIPT is not. " +
        "Provide the absolute path of a send-matrix subprocess accepting --as, --stdin, --room.",
    );
  }
  let targets: Record<string, { matrix?: { room: string } }> = {};
  const targetsJson = env.AGENTS_MCP_TARGETS_JSON;
  if (targetsJson) {
    try {
      const parsed = JSON.parse(targetsJson) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("must be a JSON object");
      }
      targets = parsed as Record<string, { matrix?: { room: string } }>;
    } catch (err) {
      throw new Error(
        `[agents-mcp-mount] AGENTS_MCP_TARGETS_JSON parse failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const ttlRaw = env.AGENTS_MCP_JWT_TTL_SECONDS;
  const jwtTtlSeconds = ttlRaw ? Number(ttlRaw) : 900;
  if (!Number.isFinite(jwtTtlSeconds) || jwtTtlSeconds <= 0) {
    throw new Error("[agents-mcp-mount] AGENTS_MCP_JWT_TTL_SECONDS must be a positive number");
  }
  // AJS-55 trust manifest env parsing. Both paths must be set together;
  // setting one without the other is a startup error so operators see
  // the misconfig clearly.
  const trustManifestPath = env.AGENTS_MCP_TRUST_MANIFEST_PATH;
  const trustRootPath = env.AGENTS_MCP_TRUST_ROOT_PATH;
  if ((trustManifestPath && !trustRootPath) || (trustRootPath && !trustManifestPath)) {
    throw new Error(
      "[agents-mcp-mount] AGENTS_MCP_TRUST_MANIFEST_PATH and AGENTS_MCP_TRUST_ROOT_PATH must be set together (AJS-55 challenge mint substrate). Set both or neither.",
    );
  }
  let challengeRateLimit: { ratePerMinute: number; burst: number } | undefined;
  const rateLimitRaw = env.AGENTS_MCP_CHALLENGE_RATE_LIMIT;
  if (rateLimitRaw) {
    // Spec: `<rate>/<window>:<burst>`. v1 supports `min` window only.
    const match = /^(\d+)\/min:(\d+)$/.exec(rateLimitRaw);
    if (!match) {
      throw new Error(
        `[agents-mcp-mount] AGENTS_MCP_CHALLENGE_RATE_LIMIT must match \`<rate>/min:<burst>\` (e.g. "30/min:10"); got "${rateLimitRaw}"`,
      );
    }
    challengeRateLimit = {
      ratePerMinute: Number(match[1]),
      burst: Number(match[2]),
    };
  }

  return {
    signingKey: new TextEncoder().encode(signingKeyText),
    issuer,
    audience: env.AGENTS_MCP_JWT_AUDIENCE ?? "agents-js-mcp",
    sendScript,
    ...(env.AGENTS_MCP_AGENT_MSG_BIN ? { agentMsgBin: env.AGENTS_MCP_AGENT_MSG_BIN } : {}),
    targets,
    ...(env.AGENTS_MCP_ADMIN_TOKEN ? { adminToken: env.AGENTS_MCP_ADMIN_TOKEN } : {}),
    jwtTtlSeconds,
    ...(trustManifestPath ? { trustManifestPath } : {}),
    ...(trustRootPath ? { trustRootPath } : {}),
    ...(challengeRateLimit ? { challengeRateLimit } : {}),
  };
}

/**
 * Build a {@link MatrixTool} that spawns the configured send-matrix
 * subprocess with `--as <identity>` and pipes the message body via
 * stdin. Identity is taken from the server-resolved
 * {@link AuthenticatedIdentity}, never from caller args.
 */
export function createSubprocessMatrixTool(scriptPath: string): MatrixTool {
  return {
    async send(args: MatrixSendArgs): Promise<MatrixSendResult> {
      const cliArgs = buildSendMatrixCliArgs(args);
      const proc = spawn(scriptPath, cliArgs, { stdio: ["pipe", "pipe", "inherit"] });
      proc.stdin.end(args.body);
      const chunks: Uint8Array[] = [];
      proc.stdout.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      const code: number = await new Promise<number>((resolve, reject) => {
        proc.on("error", reject);
        proc.on("exit", (c) => resolve(c ?? 1));
      });
      const stdout = Buffer.concat(chunks as Buffer[])
        .toString("utf8")
        .trim();
      if (code !== 0) {
        throw new Error(
          `[agents-mcp-mount] matrix-send subprocess ${scriptPath} exited ${code}: ${stdout}`,
        );
      }
      const match = /\$\S+/.exec(stdout);
      const event_id = match ? match[0] : stdout || "unknown";
      return { event_id };
    },
  };
}

export function buildSendMatrixCliArgs(args: MatrixSendArgs): string[] {
  const cliArgs = [
    "--as",
    args.identity.agentName,
    "--stdin",
    "--room",
    args.room,
    "--to",
    args.target,
  ];
  if (args.replyToEventId) {
    cliArgs.push("--reply-to", args.replyToEventId);
  }
  return cliArgs;
}

/**
 * UUID v1-v5 pattern. agent-msg's `MessageMetaSchema.correlationId`
 * uses `z.string().uuid()` which requires this exact shape. AJS-57's
 * `cid` claim is loosely typed as "non-empty string" (operators mint
 * human-readable cids like `"smoke-001"` for dogfood), so non-UUID
 * cids MUST NOT be forwarded into `agent-msg --correlation` or the
 * subprocess exits 1.
 *
 * Caught by @cognee-codex source-review on PR #49 (matrix event
 * `$euNwxjn7bcz9ejs-2N9jC8-4gaGYStQ0YlkR-0CxeMU`).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build a {@link AgentInboxTool} that spawns the `agent-msg` CLI for
 * each call. `send` writes a message to the target session's mailbox;
 * `read --json` returns pending messages for the identity's session.
 *
 * Identity is server-resolved from the JWT — `--from <identity.sub>`
 * is set from the verified session, never from caller args.
 *
 * Stdout from `agent-msg send` is a JSON object with `messageId` +
 * `createdAt`; `agent-msg read --json` is an array of message objects
 * matching the package's internal `MailboxItem` shape (we map down to
 * the {@link InboxMessage} surface here).
 *
 * Correlation id boundary: `agent-msg` requires UUID-shaped correlation
 * ids; AJS-57 `cid` claims are loosely typed. Only pass `--correlation`
 * when the cid matches the UUID pattern. Non-UUID cids are valid AJS-57
 * sessions and MUST inbox-deliver successfully; `agent-msg` generates
 * its own correlationId when the flag is omitted.
 */
/**
 * AJS-88 / DOT-502 v0.2 — agent-msg CLI flag names for the new contract
 * fields. Centralised so the graceful-skip retry path can strip the
 * post-contract flags by name when the deployed CLI predates v0.2.
 *
 * The agent-msg CLI side (cognee-codex lane) is being wired in parallel
 * via a companion ticket; flag names here are the agreed-on shapes for
 * the v0.2 surface. If the deployed CLI rejects them (pre-v0.2 binary),
 * the structured exit-code 2 path triggers a retry without these flags
 * so the inbox.deliver call still succeeds — the matrix-origin metadata
 * is lost on the row, but durable delivery is preserved.
 */
const AGENT_MSG_V02_FLAGS = ["--idempotency-key", "--matrix-origin-json", "--kind"] as const;

/**
 * Build the argv array passed to `agent-msg send`. Extracted as a
 * pure function so the UUID-gate logic for `--correlation` and the
 * AJS-88 contract-flag forwarding are unit-testable without spawning a
 * subprocess.
 *
 * AJS-88 / DOT-502 v0.2: when `args` carries the new contract fields
 * (`idempotencyKey` / `matrixOrigin` / `kind`), each is forwarded as a
 * dedicated flag. The `matrixOrigin` envelope is JSON-stringified so a
 * single CLI arg carries the whole structured payload (avoids spreading
 * five sub-flags across argv). Absent fields produce zero argv entries
 * (no `--idempotency-key undefined` accidents).
 *
 * Exported for testing.
 */
export function buildAgentMsgDeliverArgv(args: InboxDeliverArgs): string[] {
  const cliArgs = [
    "send",
    args.toSession,
    args.body,
    "--from",
    args.identity.agentName,
    "--no-notify",
  ];
  if (args.correlationId && UUID_PATTERN.test(args.correlationId)) {
    cliArgs.push("--correlation", args.correlationId);
  }
  if (typeof args.idempotencyKey === "string" && args.idempotencyKey.length > 0) {
    cliArgs.push("--idempotency-key", args.idempotencyKey);
  }
  if (args.matrixOrigin !== undefined) {
    cliArgs.push("--matrix-origin-json", JSON.stringify(args.matrixOrigin));
  }
  if (args.kind !== undefined) {
    cliArgs.push("--kind", args.kind);
  }
  return cliArgs;
}

/**
 * AJS-88 / DOT-502 v0.2 — strip the post-contract flags + their values
 * from an argv array. Used by the graceful-skip retry path after a
 * structured exit-code 2 (CLI flag-rejection) signal from the agent-msg
 * subprocess. Returns a new array; does not mutate input.
 *
 * Detection is structural: walk argv, skip any `--<known-v0.2-flag>`
 * entry plus its single value slot. NO stderr regex (banked rule
 * `feedback_no_regex_pattern_matching_for_detection`); CLI rejection is
 * detected via {@link SubprocessFailureError.exitCode === 2} upstream,
 * not by inspecting stderr text.
 */
function stripV02Flags(argv: readonly string[]): string[] {
  const v02Set = new Set<string>(AGENT_MSG_V02_FLAGS);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg === "string" && v02Set.has(arg)) {
      i += 1; // skip the value slot too
      continue;
    }
    if (typeof arg === "string") out.push(arg);
  }
  return out;
}

/**
 * Structured error thrown by {@link runSubprocess} when the spawned
 * binary exits non-zero. Carries the exit code + captured stderr as
 * typed fields so callers can branch on `err.exitCode === 2` (CLI
 * unknown-flag convention) without stderr text-matching.
 *
 * Banked rule: detection happens at the translator layer that already
 * sits between raw output and typed wire shapes; this is that layer for
 * the subprocess substrate. Stderr stays available as a diagnostic
 * field but is NEVER pattern-matched for control flow.
 */
export class SubprocessFailureError extends Error {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  constructor(opts: {
    bin: string;
    args: readonly string[];
    exitCode: number;
    stdout: string;
    stderr: string;
  }) {
    super(
      `[agents-mcp-mount] ${opts.bin} ${opts.args.join(" ")} exited ${opts.exitCode}: ${opts.stderr || opts.stdout}`,
    );
    this.name = "SubprocessFailureError";
    this.exitCode = opts.exitCode;
    this.stderr = opts.stderr;
    this.stdout = opts.stdout;
  }
}

export function createSubprocessAgentInboxTool(binPath: string): AgentInboxTool {
  return {
    async deliver(args: InboxDeliverArgs): Promise<InboxDeliverResult> {
      const cliArgs = buildAgentMsgDeliverArgv(args);
      let stdout: string;
      try {
        stdout = await runSubprocess(binPath, cliArgs);
      } catch (err) {
        // AJS-88 / DOT-502 v0.2 graceful-skip: a pre-v0.2 agent-msg
        // binary exits with code 2 on an unknown flag (POSIX/Commander
        // convention). When we detect that AND we forwarded any v0.2
        // flag, retry without them so the inbox.deliver still succeeds.
        // The matrix-origin metadata is lost on the row but durable
        // delivery is preserved — which matters more during a staged
        // rollout where the gateway and CLI may deploy on different
        // ticks (spec §5 sequencing).
        //
        // Detection is structural (exitCode === 2), NOT stderr regex
        // (banked rule). The strip-and-retry runs at most once per call.
        const carriedV02Flags = cliArgs.some((a) =>
          (AGENT_MSG_V02_FLAGS as readonly string[]).includes(a),
        );
        if (err instanceof SubprocessFailureError && err.exitCode === 2 && carriedV02Flags) {
          const fallbackArgs = stripV02Flags(cliArgs);
          stdout = await runSubprocess(binPath, fallbackArgs);
        } else {
          throw err;
        }
      }
      const parsed = JSON.parse(stdout) as {
        messageId?: unknown;
        createdAt?: unknown;
        alreadyDelivered?: unknown;
      };
      if (typeof parsed.messageId !== "string" || typeof parsed.createdAt !== "string") {
        throw new Error(
          `[agents-mcp-mount] agent-msg send returned unexpected JSON: ${stdout.slice(0, 200)}`,
        );
      }
      const result: InboxDeliverResult = {
        message_id: parsed.messageId,
        created_at: parsed.createdAt,
      };
      // AJS-88 / DOT-502 v0.2 — surface the `already_delivered` flag
      // when the CLI returns it. CLI predates the flag → field absent
      // on `parsed`; result stays without `already_delivered` and the
      // bridge fanout treats the call as a fresh delivery (acceptable
      // per Stage 1 sequencing — the partial UNIQUE index lands with
      // the CLI companion).
      if (parsed.alreadyDelivered === true) {
        result.already_delivered = true;
      }
      return result;
    },
    async read(args: InboxReadArgs): Promise<InboxMessage[]> {
      const cliArgs = [
        "read",
        "--session",
        args.session,
        "--json",
        "--limit",
        String(args.limit ?? 20),
      ];
      const stdout = await runSubprocess(binPath, cliArgs);
      const parsed = JSON.parse(stdout) as Array<{
        message?: {
          meta?: {
            messageId?: unknown;
            fromSession?: unknown;
            toSession?: unknown;
            createdAt?: unknown;
            priority?: unknown;
            // AJS-88 / DOT-502 v0.2 — additive fields on the read shape.
            // Pre-contract rows have neither; CLI predating v0.2 emits
            // neither. Both flow through normalizeInboxKind /
            // parseMatrixOriginEnvelope at the read boundary so the
            // returned InboxMessage shape always validates.
            kind?: unknown;
            matrixOrigin?: unknown;
          };
          params?: { text?: unknown };
        };
      }>;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item): InboxMessage | null => {
          const meta = item.message?.meta;
          if (
            typeof meta?.messageId !== "string" ||
            typeof meta?.fromSession !== "string" ||
            typeof meta?.toSession !== "string" ||
            typeof meta?.createdAt !== "string"
          ) {
            return null;
          }
          const body =
            typeof item.message?.params?.text === "string" ? item.message.params.text : "";
          const priority =
            meta.priority === "low" || meta.priority === "normal" || meta.priority === "high"
              ? meta.priority
              : undefined;
          // AJS-88 / DOT-502 v0.2 — read-side parsing of new fields.
          // `kind` runs through normalizeInboxKind so unknown / absent
          // collapses to "agents_message" (spec §7 default). Only
          // surface the field on the result row when the CLI actually
          // returned it AND it parsed to a known kind — preserves
          // pre-contract row shape (no synthetic `kind` injection).
          const kindRaw = meta.kind;
          const kind: InboxKind | undefined =
            typeof kindRaw === "string" ? normalizeInboxKind(kindRaw) : undefined;
          const matrixOrigin = parseMatrixOriginEnvelope(meta.matrixOrigin);
          return {
            message_id: meta.messageId,
            from_session: meta.fromSession,
            to_session: meta.toSession,
            created_at: meta.createdAt,
            body,
            ...(priority ? { priority } : {}),
            ...(kind !== undefined ? { kind } : {}),
            ...(matrixOrigin !== undefined ? { matrix_origin: matrixOrigin } : {}),
          };
        })
        .filter((m): m is InboxMessage => m !== null);
    },
  };
}

/**
 * AJS-88 / DOT-502 v0.2 — parse a raw `matrix_origin` JSON object from
 * `agent-msg read --json` output into the typed envelope. Returns
 * undefined when input is absent / malformed (defensive: pre-contract
 * rows have no envelope; partial / corrupt envelopes should not surface
 * with missing required fields).
 *
 * Exported for testing.
 */
export function parseMatrixOriginEnvelope(raw: unknown): MatrixOriginEnvelope | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.event_id !== "string" ||
    typeof obj.room_id !== "string" ||
    typeof obj.sender !== "string" ||
    typeof obj.origin_server_ts !== "number"
  ) {
    return undefined;
  }
  const envelope: MatrixOriginEnvelope = {
    event_id: obj.event_id,
    room_id: obj.room_id,
    sender: obj.sender,
    origin_server_ts: obj.origin_server_ts,
  };
  if (typeof obj.reply_to_event_id === "string") {
    envelope.reply_to_event_id = obj.reply_to_event_id;
  }
  return envelope;
}

/**
 * Spawn a subprocess + capture stdout. Used by the inbox provider
 * for both `send` and `read --json`. Throws {@link SubprocessFailureError}
 * (carrying exit code + stderr as structured fields) on non-zero exit
 * so callers can branch on the exit code without stderr text-matching.
 */
async function runSubprocess(bin: string, args: readonly string[]): Promise<string> {
  const proc = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  const outChunks: Uint8Array[] = [];
  const errChunks: Uint8Array[] = [];
  proc.stdout.on("data", (c: Uint8Array) => outChunks.push(c));
  proc.stderr.on("data", (c: Uint8Array) => errChunks.push(c));
  const code: number = await new Promise<number>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (c) => resolve(c ?? 1));
  });
  const stdout = Buffer.concat(outChunks as Buffer[])
    .toString("utf8")
    .trim();
  const stderr = Buffer.concat(errChunks as Buffer[])
    .toString("utf8")
    .trim();
  if (code !== 0) {
    throw new SubprocessFailureError({ bin, args, exitCode: code, stdout, stderr });
  }
  return stdout;
}

/** Test seam — every collaborator that does real I/O is overridable. */
export interface SetupAgentsMcpOverrides {
  matrixTool?: MatrixTool;
  agentInboxTool?: AgentInboxTool;
  env?: Record<string, string | undefined>;
  config?: AgentsMcpEnvConfig | null;
  now?: () => Date;
  /**
   * AJS-55 substrate overrides. When omitted, /api/agents/mint/challenge
   * + /api/agents/mint/redeem return 503 (substrate not configured).
   * Test fixtures wire a stub `peerKeyDirectory` to exercise the mint
   * flow without spinning up a real trust manifest.
   */
  peerKeyDirectory?: PeerKeyDirectory;
  challengeStore?: ChallengeMintStore;
  ipRateLimiter?: IpRateLimiter;
  /** Test seam: override the cid generator (defaults to crypto.randomUUID). */
  cidGenerator?: () => string;
}

/** Return shape for {@link setupAgentsMcpMount}. */
export interface AgentsMcpWireup {
  fetchHandler: (req: Request) => Promise<Response | null>;
  dispatcher: AgentsDispatcher;
  /**
   * Stop any background work the mount started (trust-manifest fs.watch
   * handle, future timer-based sweeps). Safe to call when no background
   * work is running. Tests MUST call this in their teardown to avoid
   * leaked fs.watch handles keeping the test process alive.
   */
  stop(): void;
}

/**
 * Compose the mount. Returns `null` when the feature gate is off.
 *
 * Now async because trust-manifest auto-load (env-driven AJS-55 wireup)
 * calls `await watchTrustManifest(...)` to do an initial load + start
 * the fs.watch debouncer. Synchronous override paths (tests + back-compat
 * deploys without trust manifest) still resolve immediately.
 */
export async function setupAgentsMcpMount(opts: {
  overrides?: SetupAgentsMcpOverrides;
}): Promise<AgentsMcpWireup | null> {
  const overrides = opts.overrides ?? {};
  const config =
    overrides.config !== undefined ? overrides.config : readAgentsMcpEnv(overrides.env);
  if (config === null) return null;

  const targetDirectory: TargetDirectory = {
    resolve(target: string) {
      const entry = config.targets[target];
      return entry ?? null;
    },
  };

  const matrixTool = overrides.matrixTool ?? createSubprocessMatrixTool(config.sendScript);
  const agentInboxTool =
    overrides.agentInboxTool ??
    (config.agentMsgBin ? createSubprocessAgentInboxTool(config.agentMsgBin) : undefined);
  const dispatcher = createAgentsDispatcher({
    matrixTool,
    ...(agentInboxTool ? { agentInboxTool } : {}),
    targetDirectory,
  });

  // AJS-55 substrate auto-wire from env. When AGENTS_MCP_TRUST_MANIFEST_PATH +
  // AGENTS_MCP_TRUST_ROOT_PATH are set, the gateway loads + watches the
  // manifest at startup. The resulting peerKeyDirectory + challengeStore
  // + ipRateLimiter are threaded into the mint endpoints (POST
  // /api/agents/mint/challenge + /redeem). Tests wire concrete stubs via
  // SetupAgentsMcpOverrides; production reads the env paths above.
  let trustManifestHandle: ReloadableTrustManifest | null = null;
  if (config.trustManifestPath && config.trustRootPath && !overrides.peerKeyDirectory) {
    trustManifestHandle = await watchTrustManifest({
      manifestPath: config.trustManifestPath,
      trustRootPath: config.trustRootPath,
    });
  }
  const peerKeyDirectory: PeerKeyDirectory | null =
    overrides.peerKeyDirectory ?? trustManifestHandle?.peerKeyDirectory ?? null;
  const challengeStore =
    overrides.challengeStore ??
    (peerKeyDirectory !== null
      ? createChallengeMintStore({ ttlMs: 60_000, sizeCap: 10_000 })
      : null);
  const ipRateLimiter =
    overrides.ipRateLimiter ??
    (peerKeyDirectory !== null
      ? createIpRateLimiter(config.challengeRateLimit ?? { ratePerMinute: 30, burst: 10 })
      : null);
  const cidGenerator = overrides.cidGenerator ?? (() => randomUUID());

  const fetchHandler = createAgentsMcpFetchHandler({
    config,
    dispatcher,
    now: overrides.now,
    peerKeyDirectory,
    challengeStore,
    ipRateLimiter,
    cidGenerator,
  });

  const stop = (): void => {
    if (trustManifestHandle !== null) {
      trustManifestHandle.stop();
      trustManifestHandle = null;
    }
  };

  return { fetchHandler, dispatcher, stop };
}

function createAgentsMcpFetchHandler(opts: {
  config: AgentsMcpEnvConfig;
  dispatcher: AgentsDispatcher;
  now?: () => Date;
  peerKeyDirectory: PeerKeyDirectory | null;
  challengeStore: ChallengeMintStore | null;
  ipRateLimiter: IpRateLimiter | null;
  cidGenerator: () => string;
}): (req: Request) => Promise<Response | null> {
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/agents/")) return null;

    if (url.pathname === "/api/agents/send_message") {
      return handleSendMessage({ req, config: opts.config, dispatcher: opts.dispatcher });
    }
    if (url.pathname === "/api/agents/get_messages") {
      return handleGetMessages({ req, config: opts.config, dispatcher: opts.dispatcher });
    }
    if (url.pathname === "/api/agents/admin/mint") {
      return handleAdminMint({ req, config: opts.config, now: opts.now });
    }
    if (url.pathname === "/api/agents/mint/challenge") {
      return handleMintChallenge({
        req,
        challengeStore: opts.challengeStore,
        ipRateLimiter: opts.ipRateLimiter,
        now: opts.now,
      });
    }
    if (url.pathname === "/api/agents/mint/redeem") {
      return handleMintRedeem({
        req,
        config: opts.config,
        challengeStore: opts.challengeStore,
        peerKeyDirectory: opts.peerKeyDirectory,
        cidGenerator: opts.cidGenerator,
        now: opts.now,
      });
    }
    return new Response(JSON.stringify({ error: "unknown agents-mcp route" }), {
      status: HTTP_STATUS.NOT_FOUND,
      headers: JSON_HEADERS,
    });
  };
}

async function handleGetMessages(opts: {
  req: Request;
  config: AgentsMcpEnvConfig;
  dispatcher: AgentsDispatcher;
}): Promise<Response> {
  const { req, config, dispatcher } = opts;
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: HTTP_STATUS.METHOD_NOT_ALLOWED,
      headers: { ...JSON_HEADERS, Allow: "POST" },
    });
  }
  const token = extractBearerToken(req.headers.get("Authorization"));
  if (token === null) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "missing-bearer",
        message: "Authorization: Bearer <jwt> required",
      }),
      {
        status: HTTP_STATUS.UNAUTHORIZED,
        headers: { ...JSON_HEADERS, "WWW-Authenticate": 'Bearer realm="agents-js-mcp"' },
      },
    );
  }
  const verification = await verifyJwt(token, {
    signingKey: config.signingKey,
    issuer: config.issuer,
    audience: config.audience,
  });
  if (!verification.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: verification.reason, message: verification.message }),
      { status: HTTP_STATUS.UNAUTHORIZED, headers: JSON_HEADERS },
    );
  }

  let rawArgs: GetMessagesArgs;
  try {
    // GET-shaped intent over POST so JSON body is the args carrier;
    // accept empty body as "use defaults" rather than failing.
    const text = await req.text();
    rawArgs = text ? (JSON.parse(text) as GetMessagesArgs) : {};
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "invalid-args",
        correlation_id: verification.identity.correlationId,
        message: "request body must be valid JSON",
      }),
      { status: HTTP_STATUS.BAD_REQUEST, headers: JSON_HEADERS },
    );
  }

  const result: GetMessagesResult = await dispatcher.getMessages(rawArgs, verification.identity);
  const status = result.ok
    ? HTTP_STATUS.OK
    : result.error === "scope-not-granted"
      ? 403
      : result.error === "forbidden-target"
        ? 403
        : result.error === "invalid-args"
          ? HTTP_STATUS.BAD_REQUEST
          : HTTP_STATUS.INTERNAL_SERVER_ERROR;
  return new Response(JSON.stringify(result), { status, headers: JSON_HEADERS });
}

async function handleSendMessage(opts: {
  req: Request;
  config: AgentsMcpEnvConfig;
  dispatcher: AgentsDispatcher;
}): Promise<Response> {
  const { req, config, dispatcher } = opts;
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: HTTP_STATUS.METHOD_NOT_ALLOWED,
      headers: { ...JSON_HEADERS, Allow: "POST" },
    });
  }

  const token = extractBearerToken(req.headers.get("Authorization"));
  if (token === null) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "missing-bearer",
        message: "Authorization: Bearer <jwt> required",
      }),
      {
        status: HTTP_STATUS.UNAUTHORIZED,
        headers: { ...JSON_HEADERS, "WWW-Authenticate": 'Bearer realm="agents-js-mcp"' },
      },
    );
  }
  const verification = await verifyJwt(token, {
    signingKey: config.signingKey,
    issuer: config.issuer,
    audience: config.audience,
  });
  if (!verification.ok) {
    return new Response(
      JSON.stringify({ ok: false, error: verification.reason, message: verification.message }),
      { status: HTTP_STATUS.UNAUTHORIZED, headers: JSON_HEADERS },
    );
  }

  let rawArgs: SendMessageArgs;
  try {
    rawArgs = (await req.json()) as SendMessageArgs;
  } catch {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "invalid-args",
        correlation_id: verification.identity.correlationId,
        message: "request body must be valid JSON",
      }),
      { status: HTTP_STATUS.BAD_REQUEST, headers: JSON_HEADERS },
    );
  }

  const result: SendMessageResult = await dispatcher.sendMessage(rawArgs, verification.identity);
  const status = result.ok
    ? HTTP_STATUS.OK
    : result.error === "scope-not-granted"
      ? 403
      : result.error === "unknown-target"
        ? HTTP_STATUS.NOT_FOUND
        : result.error === "invalid-args"
          ? HTTP_STATUS.BAD_REQUEST
          : HTTP_STATUS.INTERNAL_SERVER_ERROR;
  return new Response(JSON.stringify(result), { status, headers: JSON_HEADERS });
}

/**
 * Admin JWT mint — v1 stub for AJS-55 challenge verification.
 *
 * Gated by `Authorization: Admin <AGENTS_MCP_ADMIN_TOKEN>` header.
 * Operators MUST disable this in production until AJS-55 ed25519
 * challenge verification lands.
 */
async function handleAdminMint(opts: {
  req: Request;
  config: AgentsMcpEnvConfig;
  now?: () => Date;
}): Promise<Response> {
  const { req, config } = opts;
  // AJS-55 v1 deprecation: when AGENTS_MCP_DISABLE_ADMIN_MINT=1, the
  // /admin/mint endpoint is hard-disabled (404). Operators should
  // migrate to /api/agents/mint/challenge + /redeem (cryptographic
  // challenge mint) before flipping this kill-switch.
  if (Bun.env.AGENTS_MCP_DISABLE_ADMIN_MINT === "1") {
    return new Response(
      JSON.stringify({
        error:
          "admin mint disabled by AGENTS_MCP_DISABLE_ADMIN_MINT=1; use /api/agents/mint/challenge + /redeem (AJS-55)",
      }),
      { status: HTTP_STATUS.NOT_FOUND, headers: JSON_HEADERS },
    );
  }
  if (!config.adminToken) {
    return new Response(
      JSON.stringify({ error: "admin mint disabled — set AGENTS_MCP_ADMIN_TOKEN to enable" }),
      { status: HTTP_STATUS.NOT_FOUND, headers: JSON_HEADERS },
    );
  }
  // Deprecation log: every successful admin-mint call emits a warning so
  // operators see migration pressure in their logs (vault doc §"Out of
  // M1" admin-mint deprecation).
  console.warn(
    "[agents-mcp-mount] /api/agents/admin/mint is a v1 stub deprecated by AJS-55; migrate to /api/agents/mint/challenge + /redeem cryptographic challenge mint. Set AGENTS_MCP_DISABLE_ADMIN_MINT=1 once migrated.",
  );
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: HTTP_STATUS.METHOD_NOT_ALLOWED,
      headers: { ...JSON_HEADERS, Allow: "POST" },
    });
  }
  const authHeader = req.headers.get("Authorization");
  const adminMatch = /^Admin\s+(.+)$/i.exec(authHeader ?? "");
  if (!adminMatch || adminMatch[1]?.trim() !== config.adminToken) {
    return new Response(JSON.stringify({ error: "admin token required" }), {
      status: HTTP_STATUS.UNAUTHORIZED,
      headers: JSON_HEADERS,
    });
  }
  let body: { sub?: unknown; scopes?: unknown; cid?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "request body must be valid JSON" }), {
      status: HTTP_STATUS.BAD_REQUEST,
      headers: JSON_HEADERS,
    });
  }
  if (typeof body.sub !== "string" || body.sub.length === 0) {
    return new Response(JSON.stringify({ error: "`sub` (string) is required" }), {
      status: HTTP_STATUS.BAD_REQUEST,
      headers: JSON_HEADERS,
    });
  }
  if (typeof body.cid !== "string" || body.cid.length === 0) {
    return new Response(JSON.stringify({ error: "`cid` (string) is required" }), {
      status: HTTP_STATUS.BAD_REQUEST,
      headers: JSON_HEADERS,
    });
  }
  const scopes =
    Array.isArray(body.scopes) && body.scopes.every((s) => typeof s === "string")
      ? (body.scopes as string[])
      : [];
  const now = opts.now ? opts.now() : new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const jwt = await new SignJWT({ scopes, cid: body.cid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(body.sub)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + config.jwtTtlSeconds)
    .sign(config.signingKey);
  return new Response(
    JSON.stringify({ jwt, expires_in: config.jwtTtlSeconds, sub: body.sub, cid: body.cid }),
    { status: HTTP_STATUS.OK, headers: JSON_HEADERS },
  );
}

/**
 * Extract the source IP from a Request. Bun's `request.headers.get`
 * gives us the `X-Forwarded-For` / `X-Real-IP` chain that a reverse
 * proxy (Caddy / nginx) would set. Falls back to `"unknown"` when no
 * proxy header is present (no point in trying to read socket info from
 * Request; that's bound by the Bun.serve adapter layer).
 */
function extractClientIp(req: Request): string {
  const xff = req.headers.get("X-Forwarded-For");
  if (xff !== null) {
    // Take the leftmost (originating) IP from the chain.
    const first = xff.split(",")[0]?.trim();
    if (first && first.length > 0) return first;
  }
  const xri = req.headers.get("X-Real-IP");
  if (xri !== null && xri.length > 0) return xri.trim();
  return "unknown";
}

/**
 * AJS-55 mint-challenge endpoint. Unauthenticated (gated by per-IP
 * rate limiter); returns a 32-byte challenge + expires_at.
 *
 * Vault doc §"Challenge mint flow" step 2.
 */
async function handleMintChallenge(opts: {
  req: Request;
  challengeStore: ChallengeMintStore | null;
  ipRateLimiter: IpRateLimiter | null;
  now?: () => Date;
}): Promise<Response> {
  const { req, challengeStore, ipRateLimiter } = opts;
  if (challengeStore === null || ipRateLimiter === null) {
    return new Response(
      JSON.stringify({
        error: "AJS-55 challenge mint substrate not configured on this gateway",
      }),
      { status: 503, headers: JSON_HEADERS },
    );
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: HTTP_STATUS.METHOD_NOT_ALLOWED,
      headers: { ...JSON_HEADERS, Allow: "POST" },
    });
  }
  const nowMs = (opts.now ? opts.now() : new Date()).getTime();
  const ip = extractClientIp(req);
  const rateCheck = ipRateLimiter.check(ip, { now: nowMs });
  if (!rateCheck.ok) {
    return new Response(
      JSON.stringify({ error: "rate-limited", retry_after_ms: rateCheck.retryAfterMs }),
      {
        status: 429,
        headers: {
          ...JSON_HEADERS,
          "Retry-After": String(Math.ceil(rateCheck.retryAfterMs / 1000)),
        },
      },
    );
  }
  const issued = challengeStore.issueChallenge({ now: nowMs });
  if (!issued.ok) {
    return new Response(JSON.stringify({ error: "challenge-store-full" }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }
  return new Response(
    JSON.stringify({ challenge: issued.challenge, expires_at: issued.expiresAt }),
    { status: HTTP_STATUS.OK, headers: JSON_HEADERS },
  );
}

/**
 * AJS-55 mint-redeem endpoint. Verifies the caller's signed challenge
 * against the trust manifest's peer pubkey + mints a JWT on success.
 *
 * Vault doc §"Challenge mint flow" steps 4-6.
 */
async function handleMintRedeem(opts: {
  req: Request;
  config: AgentsMcpEnvConfig;
  challengeStore: ChallengeMintStore | null;
  peerKeyDirectory: PeerKeyDirectory | null;
  cidGenerator: () => string;
  now?: () => Date;
}): Promise<Response> {
  const { req, config, challengeStore, peerKeyDirectory, cidGenerator } = opts;
  if (challengeStore === null || peerKeyDirectory === null) {
    return new Response(
      JSON.stringify({
        error: "AJS-55 challenge mint substrate not configured on this gateway",
      }),
      { status: 503, headers: JSON_HEADERS },
    );
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: HTTP_STATUS.METHOD_NOT_ALLOWED,
      headers: { ...JSON_HEADERS, Allow: "POST" },
    });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "request body must be valid JSON" }), {
      status: HTTP_STATUS.BAD_REQUEST,
      headers: JSON_HEADERS,
    });
  }
  const nowMs = (opts.now ? opts.now() : new Date()).getTime();
  const result = redeemMintChallenge({
    request: body as Parameters<typeof redeemMintChallenge>[0]["request"],
    store: challengeStore,
    peerKeyDirectory,
    now: nowMs,
    cidGenerator,
  });
  if (!result.ok) {
    const status =
      result.reason === "invalid-args"
        ? HTTP_STATUS.BAD_REQUEST
        : result.reason === "unknown-entity"
          ? HTTP_STATUS.NOT_FOUND
          : result.reason === "invalid-signature" || result.reason === "invalid-challenge"
            ? HTTP_STATUS.UNAUTHORIZED
            : result.reason === "invalid-scope"
              ? HTTP_STATUS.BAD_REQUEST
              : HTTP_STATUS.INTERNAL_SERVER_ERROR;
    return new Response(JSON.stringify(result), { status, headers: JSON_HEADERS });
  }
  // Mint the JWT (same pattern as /admin/mint but with cryptographically-
  // verified sub + scopes + cid from the redeem flow).
  const nowSec = Math.floor(nowMs / 1000);
  const jwt = await new SignJWT({ scopes: result.scopes, cid: result.cid })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(result.sub)
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + config.jwtTtlSeconds)
    .sign(config.signingKey);
  return new Response(
    JSON.stringify({
      jwt,
      expires_in: config.jwtTtlSeconds,
      sub: result.sub,
      scopes: result.scopes,
      cid: result.cid,
    }),
    { status: HTTP_STATUS.OK, headers: JSON_HEADERS },
  );
}
