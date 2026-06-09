/**
 * Durable stdio launcher for `@agents-js/claude-channel-adapter`.
 *
 * Spawned by Claude Code via `--channels server:<name>` (research-preview:
 * `--dangerously-load-development-channels`). Drives a durable-inbox poll loop
 * and wires the outbound tools to `agents_send_message`.
 *
 * **Flow**
 * - Inbound: a {@link McpGatewayInboxClient} reads this identity's durable
 *   inbox (`agents_get_messages`) on an interval; each NEW row is emitted as a
 *   `notifications/claude/channel` frame via the adapter, surfacing as a
 *   `<channel>` tag in the running session.
 * - Outbound: the adapter's `agents_js_reply` / `agents_js_send` tools route to
 *   `agents_send_message` through the same client.
 *
 * **Credential boundary**: the inbox client spawns a provisioned
 * `agents_gateway` MCP server (command + env from `CH_GATEWAY_MCP_*`). This
 * launcher mints nothing and embeds no credential. If the gateway env is NOT
 * configured, inbound polling stays DISABLED (logged) and the launcher still
 * runs the channel server — safe to deploy before provisioning lands.
 *
 * **Env contract**
 * - `CH_LOG` — log file (default `/tmp/agentsjs-channel-launcher.log`).
 * - `CH_GATEWAY_IDENTITY` — inbox identity (default `hostname-null-claude-0`).
 * - `CH_GATEWAY_URL` + `CH_GATEWAY_KEY_CMD` — preferred transport: AJS-55
 *   challenge/redeem over HTTPS. URL e.g. `https://ajs-gateway.q4m.dev`;
 *   KEY_CMD prints the PEM ed25519 key, e.g.
 *   `gopass show services/agents-js/identity/hostname-null-claude-0/key`.
 * - `CH_GATEWAY_MCP_COMMAND` — alt transport: spawn an agents_gateway MCP
 *   server. Inbound polling is DISABLED unless one transport is configured.
 * - `CH_GATEWAY_MCP_ARGS` — JSON array (or whitespace-split) of server args.
 * - `CH_GATEWAY_ENV_JSON` — JSON object of env vars passed to that server.
 * - `CH_POLL_INTERVAL_MS` — poll cadence (default 15000).
 * - `CH_CURSOR_PATH` — dedup-cursor file (default
 *   `$HOME/.local/state/agents-js/channel-cursor-<identity>.json`).
 * - `CH_EMIT_AFTER_MS` / `CH_EMIT_CONTENT` — optional transport-ping self-test.
 */
import { appendFileSync } from "node:fs";
import { FileCursorStore } from "../src/cursor-store.ts";
import { type GatewayInboxClient, McpGatewayInboxClient } from "../src/gateway-inbox-client.ts";
import { HttpGatewayInboxClient } from "../src/http-gateway-inbox-client.ts";
import { runInboxPoller } from "../src/inbox-poller.ts";
import { createInboxSink } from "../src/inbox-sink.ts";
import { createClaudeChannelServer, createSenderGate } from "../src/index.ts";
import { resolveReplyTarget } from "../src/reply-routing.ts";

const LOG = Bun.env.CH_LOG ?? "/tmp/agentsjs-channel-launcher.log";
const log = (m: string): void => {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`);
  } catch {
    // best-effort; stdout is owned by the MCP stdio transport.
  }
};

const IDENTITY = Bun.env.CH_GATEWAY_IDENTITY ?? "hostname-null-claude-0";

/** Run a shell command and return its stdout — used to source the identity key. */
async function runForOutput(cmd: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`key command failed (exit ${proc.exitCode})`);
  }
  return stdout;
}

/** Build the durable-inbox client from env, or null when unprovisioned. */
function buildInboxClient(): GatewayInboxClient | null {
  // Preferred transport: AJS-55 challenge/redeem over HTTPS — no admin token,
  // no spawned MCP server. Needs the gateway URL + a command that prints the
  // PEM ed25519 identity key.
  const gatewayUrl = Bun.env.CH_GATEWAY_URL;
  const keyCmd = Bun.env.CH_GATEWAY_KEY_CMD;
  if (gatewayUrl && keyCmd) {
    return new HttpGatewayInboxClient({
      baseUrl: gatewayUrl,
      entity: IDENTITY,
      getPrivateKeyPem: () => runForOutput(keyCmd),
    });
  }
  // Alt transport: spawn a provisioned agents_gateway MCP server.
  const command = Bun.env.CH_GATEWAY_MCP_COMMAND;
  if (!command) return null;
  let args: string[] = [];
  const rawArgs = Bun.env.CH_GATEWAY_MCP_ARGS;
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs);
      args = Array.isArray(parsed) ? parsed.map(String) : rawArgs.split(/\s+/).filter(Boolean);
    } catch {
      args = rawArgs.split(/\s+/).filter(Boolean);
    }
  }
  let env: Record<string, string> | undefined;
  const rawEnv = Bun.env.CH_GATEWAY_ENV_JSON;
  if (rawEnv) {
    try {
      env = JSON.parse(rawEnv) as Record<string, string>;
    } catch {
      log("bad CH_GATEWAY_ENV_JSON; ignoring");
    }
  }
  // Pin the server's default identity to ours so a tool call without an
  // explicit identity still reads/sends as this agent.
  env = { AGENTS_GATEWAY_DEFAULT_IDENTITY: IDENTITY, ...(env ?? {}) };
  return new McpGatewayInboxClient({
    command,
    args,
    env,
    clientInfo: { name: `channel-launcher-${IDENTITY}`, version: "0.0.0" },
  });
}

const inboxClient = buildInboxClient();

const senderGate = createSenderGate({
  // Only the trusted poll loop emits (sender = "agents-gateway-inbox"); the real
  // author travels in meta. "test-harness" stays allow-listed for the optional
  // CH_EMIT_AFTER_MS transport ping. Per the adapter's sender-spoofing defense,
  // the gate-checked sender is this trusted relay, never row-supplied content.
  allowedSenders: ["agents-gateway-inbox", "test-harness"],
});

// Routable target of the most-recent inbound row, so a bare
// `agents_js_reply(content)` threads back to whoever pushed it instead of the
// unroutable relay sender. Set in the poller's onMessage below.
let lastReplyTarget: string | undefined;
// Optional coordinator fallback when no explicit target and no prior inbound.
const replyFallback = Bun.env.CH_REPLY_FALLBACK;

const gatewayEmit = {
  async reply(target: string | undefined, content: string) {
    if (!inboxClient) {
      log("OUTBOUND reply DROPPED (gateway not provisioned)");
      return { ok: false, detail: "gateway not provisioned" };
    }
    const resolved = resolveReplyTarget(target, lastReplyTarget, replyFallback);
    if (!resolved) {
      log(
        "OUTBOUND reply DROPPED (no routable target: no explicit target, no prior inbound, no CH_REPLY_FALLBACK)",
      );
      return {
        ok: false,
        detail: "no reply target — pass an explicit target or set CH_REPLY_FALLBACK",
      };
    }
    const res = await inboxClient.sendMessage({
      target: resolved,
      body: content,
      identity: IDENTITY,
    });
    log(
      `OUTBOUND reply target=${resolved}${target ? "" : " (resolved)"} ok=${res.ok} event_id=${res.event_id ?? ""}`,
    );
    return { ok: res.ok, detail: res.detail };
  },
  async send(target: string, content: string) {
    if (!inboxClient) {
      log(`OUTBOUND send DROPPED (gateway not provisioned) target=${target}`);
      return { ok: false, detail: "gateway not provisioned" };
    }
    const res = await inboxClient.sendMessage({ target, body: content, identity: IDENTITY });
    log(`OUTBOUND send target=${target} ok=${res.ok} event_id=${res.event_id ?? ""}`);
    return { ok: res.ok, detail: res.detail };
  },
};

const server = createClaudeChannelServer({
  serverInfo: { name: "agentsjs-channel-hostname-null", version: "0.1.0" },
  senderGate,
  gatewayEmit,
  instructions:
    "You are attached to the agents-js mesh channel. Messages from peer agents arrive as <channel> tags on your next turn. To reply, call agents_js_reply with content=<text> and NO target — the adapter routes it back to the sender of the most-recent message (shown as meta.reply_to). The <channel> tag's own sender is the relay and is not a valid target. Pass target only to override the recipient; use agents_js_send with an explicit target to message any other agent or room.",
});

await server.connect();
log("connected (stdio)");

// --- Inbound durable-inbox poll loop -------------------------------------
const abort = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    abort.abort();
  });
}

if (inboxClient) {
  const home = Bun.env.HOME ?? "/tmp";
  const cursorPath =
    Bun.env.CH_CURSOR_PATH ?? `${home}/.local/state/agents-js/channel-cursor-${IDENTITY}.json`;
  const intervalMs = Bun.env.CH_POLL_INTERVAL_MS ? Number(Bun.env.CH_POLL_INTERVAL_MS) : 15_000;
  log(`inbound poll ENABLED identity=${IDENTITY} interval=${intervalMs}ms cursor=${cursorPath}`);
  void runInboxPoller({
    client: inboxClient,
    identity: IDENTITY,
    cursorStore: new FileCursorStore(cursorPath),
    signal: abort.signal,
    intervalMs,
    logger: {
      log: (...a) => log(`[poller] ${a.map(String).join(" ")}`),
      warn: (...a) => log(`[poller][warn] ${a.map(String).join(" ")}`),
      error: (...a) => log(`[poller][error] ${a.map(String).join(" ")}`),
    },
    // The poll→emit spine is harness-agnostic (see src/inbox-sink.ts); the only
    // Claude-specific part is the emit — surfacing a row as a
    // `notifications/claude/channel` frame. `onReplyTarget` threads a bare reply
    // back to whoever pushed the most-recent row.
    onMessage: createInboxSink({
      emit: (input) => server.emitChannelMessage(input),
      onReplyTarget: (target) => {
        lastReplyTarget = target;
      },
      logger: { log },
    }),
  });
} else {
  log("inbound poll DISABLED — set CH_GATEWAY_MCP_COMMAND once provisioning lands");
}

// --- Optional transport ping (self-test) ---------------------------------
const emitAfter = Bun.env.CH_EMIT_AFTER_MS ? Number(Bun.env.CH_EMIT_AFTER_MS) : 0;
if (emitAfter > 0) {
  setTimeout(async () => {
    try {
      const res = await server.emitChannelMessage({
        content: Bun.env.CH_EMIT_CONTENT ?? "BOOT_PING from channel-launcher",
        sender: "test-harness",
        meta: { idempotency_key: "boot-1", source: "launcher" },
      });
      log(`emitChannelMessage -> ${JSON.stringify(res)}`);
    } catch (err) {
      log(`emitChannelMessage ERROR ${String(err)}`);
    }
  }, emitAfter);
}
