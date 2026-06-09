/**
 * `@agents-js/claude-channel-adapter` — Claude Code receiver-side MCP server
 * for the wake-adapter family.
 *
 * **Architectural role on the wake-adapter family map (per [ADR-0007 §Revision-2026-05-28](../../../docs/adrs/0007-wake-trigger-gateway-substrate.md))**
 *
 * `@agents-js/wake-mcp-triggers` is the SOURCE-side reference impl: gateway
 * serializes wake-adapter payloads into `notifications/wake` MCP frames. That
 * shape is the wake-adapter family wire-format reference, NOT a universal
 * harness contract. Different harnesses consume gateway wake events using the
 * transport that harness supports.
 *
 * **Why Claude Code needs its own adapter package**
 *
 * Claude Code's MCP client only surfaces method-specific listeners registered
 * via the capability handshake; it does NOT consume generic `notifications/*`
 * frames. Specifically: declaring the experimental `claude/channel` capability
 * registers a listener for the specific `notifications/claude/channel` method.
 * That capability-gated handshake is what opts Claude Code into receiving the
 * push.
 *
 * **Wire format**
 *
 * Inbound (gateway → Claude Code): adapter subscribes to gateway SSE
 * wake/inbox events, emits `method: "notifications/claude/channel"`,
 * `params: { content: <text>, meta: { source, sender, idempotency_key, ... } }`.
 * Surfaces to Claude Code as `<channel source="..." ...>content</channel>`.
 * Meta keys MUST be identifiers — underscores only, hyphens silently dropped
 * by Claude Code's serialization. See `meta-sanitizer.ts`.
 *
 * Outbound (Claude Code → mesh): adapter exposes standard MCP tools
 * `agents_js_reply` + `agents_js_send` (via ListTools/CallTool); Claude Code
 * invokes them, adapter forwards to gateway → Matrix/A2A. Bidirectional —
 * true pull, not push-only. This is why ADR-0008 SubscribedResponse is moot
 * for Claude Code specifically (Channels gives request/response natively).
 *
 * **Attach/lifecycle**
 *
 * `.mcp.json` entry or `--channels` flag, launch-time only (no mid-session
 * attach). Research-preview flag: `claude --dangerously-load-development-channels server:claude-channel-adapter`.
 * Claude Code runs persistently (bg/tmux). No delivery confirmation —
 * resolves on transport-write.
 *
 * **Security**
 *
 * Sender-gate on SENDER AGENT IDENTITY before emitting (NOT chat/room id) to
 * prevent injection. Local primitive (`sender-gate.ts`) for now; extraction
 * to `@agents-js/policy` follow-up tracked separately (AJS-XX, will file
 * when extraction pattern is needed by a second consumer).
 *
 * @packageDocumentation
 */

/**
 * Reusable inbox-poller primitive (BL-54 / #88).
 *
 * `runInboxPoller` + a transport (`HttpGatewayInboxClient`) + a cursor-store
 * (`FileCursorStore` for durability across restarts, `MemoryCursorStore` for
 * tests) is the harness-agnostic auto-read core: it polls an identity's durable
 * gateway inbox, dedups (`dedupKey`: idempotency_key else message_id), guards
 * against surfacing another identity's inbox, and persists a seen-cursor. It was
 * previously internal to `bin/launcher.ts` (the Claude sink); exporting it lets
 * other consumers — the lifestone maildrop router, the Codex sink, any harness
 * adapter — compose a runtime entry by injecting their own `onMessage` sink
 * instead of re-implementing the poll loop.
 */
export { curlFetch, selectFetchImpl } from "./curl-fetch.ts";
export {
  type CursorState,
  type CursorStore,
  FileCursorStore,
  MemoryCursorStore,
} from "./cursor-store.ts";
export type {
  GatewayInboxClient,
  GetMessagesResult,
  InboxMessage,
  MatrixOrigin,
  SendMessageResult,
} from "./gateway-inbox-client.ts";
export {
  HttpGatewayInboxClient,
  type HttpGatewayInboxClientOptions,
} from "./http-gateway-inbox-client.ts";
export {
  dedupKey,
  type InboxPollerOptions,
  type PollerLogger,
  runInboxPoller,
} from "./inbox-poller.ts";
export {
  type ChannelEmit,
  createInboxSink,
  type InboxSinkOptions,
} from "./inbox-sink.ts";
export { type SanitizedMeta, sanitizeMetaForChannel } from "./meta-sanitizer.ts";
export {
  createSenderGate,
  type SenderGate,
  type SenderGateConfig,
} from "./sender-gate.ts";
export {
  type ClaudeChannelServer,
  type CreateClaudeChannelServerOptions,
  createClaudeChannelServer,
} from "./server.ts";
