/**
 * Internal-gateway wiring for the Gitea webhook bridge (AJS-59 v1 PR 3/3).
 *
 * Opt-in via env. The gateway exposes `POST /webhooks/gitea` ONLY when
 * `GITEA_WEBHOOK_SECRET` is set; otherwise this module returns `null`
 * and the gateway boots exactly as before. Dev-mode startup stays
 * unaffected — no implicit webhook surface.
 *
 * Wires three pieces together:
 *   1. `createGiteaWebhookHandler` — HMAC-verifies the incoming POST,
 *      dedupes by `X-Gitea-Delivery`, filters by allowlist, and
 *      publishes `gateway.gitea.event-received` onto the bus.
 *   2. `startGiteaBusConsumer` — subscribes to that topic, formats a
 *      Matrix body, and invokes a `send` callback.
 *   3. A subprocess `send` callback that spawns the script at
 *      `GITEA_BRIDGE_SEND_SCRIPT` (the deployment role renders the
 *      send-matrix adapter on the host filesystem and points the env
 *      var at it; in dev, point it at any executable that accepts
 *      `--as`, `--stdin`, and optional `--room`).
 *
 * Each piece is independently overridable in tests via {@link setupGiteaBridge}'s
 * `overrides` arg — useful for asserting wire-up without spawning
 * subprocesses or touching env.
 */

import { spawn } from "node:child_process";
import { createGiteaWebhookHandler } from "@agents-js/gitea-bridge";
import {
  type GatewayBus,
  type GiteaBusConsumerHandle,
  type GiteaSendFunction,
  startGiteaBusConsumer,
} from "@agents-js/host";

/**
 * Env-var contract for the Gitea bridge mount.
 *
 * - `GITEA_WEBHOOK_SECRET` — REQUIRED to enable. HMAC secret matching
 *   the value configured in Gitea's webhook settings.
 * - `GITEA_BRIDGE_SEND_SCRIPT` — REQUIRED when enabled. Absolute path
 *   to the send-matrix subprocess. The deployment role is expected to
 *   render an adapter on the host filesystem and point the env var at
 *   it; the script must accept `--as <identity>` and `--stdin`, plus
 *   an optional `--room <id>`.
 * - `GITEA_BRIDGE_ROOM` — OPTIONAL. Target Matrix room ID; passed
 *   through to the send script as `--room`. If unset the send script's
 *   default routing applies.
 * - `GITEA_BRIDGE_ALLOWED_REPOS` — OPTIONAL. Comma-separated list of
 *   `owner/name` allowlist entries. If unset, all repos are allowed
 *   (HMAC still enforced).
 * - `GITEA_BRIDGE_IDENTITY` — OPTIONAL. Matrix identity to send AS.
 *   Defaults to `gitea-bot`.
 */
export interface GiteaBridgeEnvConfig {
  /** HMAC secret matching Gitea webhook config. */
  secret: string;
  /** Absolute path to send-matrix subprocess. */
  sendScript: string;
  /** Target Matrix room ID, optional. */
  room?: string;
  /** Per-repo allowlist (CSV-parsed); empty array = allow all. */
  allowedRepos: readonly string[];
  /** Matrix identity. Defaults to `"gitea-bot"`. */
  identity: string;
}

/**
 * Parse the gateway env for Gitea bridge config. Returns `null` when
 * `GITEA_WEBHOOK_SECRET` is unset — that's the "feature disabled" signal.
 * Throws a clear error when required-when-enabled vars are missing so
 * the gateway fails fast on misconfiguration rather than booting into
 * a half-wired state.
 */
export function readGiteaBridgeEnv(
  env: Record<string, string | undefined> = Bun.env,
): GiteaBridgeEnvConfig | null {
  const secret = env.GITEA_WEBHOOK_SECRET;
  if (!secret) return null;

  const sendScript = env.GITEA_BRIDGE_SEND_SCRIPT;
  if (!sendScript) {
    throw new Error(
      "[gitea-bridge-mount] GITEA_WEBHOOK_SECRET is set but GITEA_BRIDGE_SEND_SCRIPT is not. " +
        "Set GITEA_BRIDGE_SEND_SCRIPT to the absolute path of a send-matrix subprocess that " +
        "accepts `--as <identity>`, `--stdin`, and an optional `--room <id>`.",
    );
  }

  const allowedReposRaw = env.GITEA_BRIDGE_ALLOWED_REPOS;
  const allowedRepos = allowedReposRaw
    ? allowedReposRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];

  return {
    secret,
    sendScript,
    room: env.GITEA_BRIDGE_ROOM,
    allowedRepos,
    identity: env.GITEA_BRIDGE_IDENTITY ?? "gitea-bot",
  };
}

/**
 * Build a {@link GiteaSendFunction} that spawns `scriptPath` and pipes
 * the message body to its stdin. Mirrors the dot-notification subprocess
 * pattern.
 *
 * The script is expected to accept `--as <identity>` and `--stdin` and
 * optionally `--room <id>`. Non-zero exit codes throw so the consumer's
 * try/catch logs the failure (and the subscription stays alive).
 */
export function createSubprocessGiteaSend(scriptPath: string): GiteaSendFunction {
  return async ({ body, identity, room }) => {
    const args = ["--as", identity, "--stdin"];
    if (room) args.push("--room", room);
    const proc = spawn(scriptPath, args, {
      stdio: ["pipe", "inherit", "inherit"],
    });
    proc.stdin.end(body);
    const code: number = await new Promise<number>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("exit", (c) => resolve(c ?? 1));
    });
    if (code !== 0) {
      throw new Error(`[gitea-bridge-mount] send subprocess ${scriptPath} exited ${code}`);
    }
  };
}

/** Test seam — every collaborator that does real I/O is overridable. */
export interface SetupGiteaBridgeOverrides {
  /** Override the subprocess sender (tests inject a recording sender). */
  send?: GiteaSendFunction;
  /** Override env-read; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Override the env parser; tests can inject already-parsed config. */
  config?: GiteaBridgeEnvConfig | null;
}

/** Both halves of the wire-up, returned together so main.ts threads them out. */
export interface GiteaBridgeWireup {
  /** Mount this in the `additionalFetch` chain. Self-routes on `/webhooks/gitea`. */
  fetchHandler: (req: Request) => Promise<Response | null>;
  /** Bus consumer; stop on shutdown. */
  consumer: GiteaBusConsumerHandle;
}

/**
 * Compose the receiver + consumer wire-up. Returns `null` when the
 * feature is disabled (no `GITEA_WEBHOOK_SECRET`).
 *
 * @param opts.bus — the gateway's in-process bus instance.
 * @param opts.overrides — test seams; see {@link SetupGiteaBridgeOverrides}.
 */
export function setupGiteaBridge(opts: {
  bus: GatewayBus;
  overrides?: SetupGiteaBridgeOverrides;
}): GiteaBridgeWireup | null {
  const overrides = opts.overrides ?? {};
  const config =
    overrides.config !== undefined ? overrides.config : readGiteaBridgeEnv(overrides.env);
  if (config === null) return null;

  const fetchHandler = createGiteaWebhookHandler({
    bus: opts.bus,
    secret: config.secret,
    ...(config.allowedRepos.length > 0 ? { allowedRepos: config.allowedRepos } : {}),
  });

  const send = overrides.send ?? createSubprocessGiteaSend(config.sendScript);

  const consumer = startGiteaBusConsumer({
    bus: opts.bus,
    send,
    identity: config.identity,
    ...(config.room ? { room: config.room } : {}),
  });

  return { fetchHandler, consumer };
}
