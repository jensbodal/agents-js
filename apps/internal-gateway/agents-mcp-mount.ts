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
import { HTTP_STATUS } from "@agents-js/a2a";
import {
  type AgentInboxTool,
  type AgentsDispatcher,
  type AuthenticatedIdentity,
  createAgentsDispatcher,
  extractBearerToken,
  type GetMessagesArgs,
  type GetMessagesResult,
  type InboxDeliverArgs,
  type InboxDeliverResult,
  type InboxMessage,
  type InboxReadArgs,
  type MatrixSendArgs,
  type MatrixSendResult,
  type MatrixTool,
  type SendMessageArgs,
  type SendMessageResult,
  type TargetDirectory,
  verifyJwt,
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
  return {
    signingKey: new TextEncoder().encode(signingKeyText),
    issuer,
    audience: env.AGENTS_MCP_JWT_AUDIENCE ?? "agents-js-mcp",
    sendScript,
    ...(env.AGENTS_MCP_AGENT_MSG_BIN ? { agentMsgBin: env.AGENTS_MCP_AGENT_MSG_BIN } : {}),
    targets,
    ...(env.AGENTS_MCP_ADMIN_TOKEN ? { adminToken: env.AGENTS_MCP_ADMIN_TOKEN } : {}),
    jwtTtlSeconds,
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
      const cliArgs = ["--as", args.identity.agentName, "--stdin", "--room", args.room];
      if (args.replyToEventId) {
        cliArgs.push("--reply-to", args.replyToEventId);
      }
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
 * Build the argv array passed to `agent-msg send`. Extracted as a
 * pure function so the UUID-gate logic for `--correlation` is
 * unit-testable without spawning a subprocess.
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
  return cliArgs;
}

export function createSubprocessAgentInboxTool(binPath: string): AgentInboxTool {
  return {
    async deliver(args: InboxDeliverArgs): Promise<InboxDeliverResult> {
      const cliArgs = buildAgentMsgDeliverArgv(args);
      const stdout = await runSubprocess(binPath, cliArgs);
      const parsed = JSON.parse(stdout) as { messageId?: unknown; createdAt?: unknown };
      if (typeof parsed.messageId !== "string" || typeof parsed.createdAt !== "string") {
        throw new Error(
          `[agents-mcp-mount] agent-msg send returned unexpected JSON: ${stdout.slice(0, 200)}`,
        );
      }
      return { message_id: parsed.messageId, created_at: parsed.createdAt };
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
          return {
            message_id: meta.messageId,
            from_session: meta.fromSession,
            to_session: meta.toSession,
            created_at: meta.createdAt,
            body,
            ...(priority ? { priority } : {}),
          };
        })
        .filter((m): m is InboxMessage => m !== null);
    },
  };
}

/**
 * Spawn a subprocess + capture stdout. Used by the inbox provider
 * for both `send` and `read --json`. Throws with stderr context on
 * non-zero exit.
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
    throw new Error(
      `[agents-mcp-mount] ${bin} ${args.join(" ")} exited ${code}: ${stderr || stdout}`,
    );
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
}

/** Return shape for {@link setupAgentsMcpMount}. */
export interface AgentsMcpWireup {
  fetchHandler: (req: Request) => Promise<Response | null>;
  dispatcher: AgentsDispatcher;
}

/**
 * Compose the mount. Returns `null` when the feature gate is off.
 */
export function setupAgentsMcpMount(opts: {
  overrides?: SetupAgentsMcpOverrides;
}): AgentsMcpWireup | null {
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

  const fetchHandler = createAgentsMcpFetchHandler({ config, dispatcher, now: overrides.now });

  return { fetchHandler, dispatcher };
}

function createAgentsMcpFetchHandler(opts: {
  config: AgentsMcpEnvConfig;
  dispatcher: AgentsDispatcher;
  now?: () => Date;
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
  if (!config.adminToken) {
    return new Response(
      JSON.stringify({ error: "admin mint disabled — set AGENTS_MCP_ADMIN_TOKEN to enable" }),
      { status: HTTP_STATUS.NOT_FOUND, headers: JSON_HEADERS },
    );
  }
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
