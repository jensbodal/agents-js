/**
 * `@agents-js/gateway-inbox-runtime` — harness-neutral durable-inbox runtime.
 *
 * This package owns the gateway inbox primitives that are shared by Claude,
 * Codex, lifestone maildrops, and future receivers. It deliberately excludes
 * harness-specific transports such as Claude Code MCP channels and Codex turn
 * delivery adapters.
 *
 * @packageDocumentation
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
  buildSignedBytes,
  CHALLENGE_MINT_DOMAIN,
  canonicalSignedObject,
  type MintOptions,
  type MintResult,
  mintGatewayJwt,
} from "./gateway-mint.ts";
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
  type InboxSinkEmitResult,
  type InboxSinkOptions,
} from "./inbox-sink.ts";
export {
  type ReplyRoutingRow,
  replyTargetForRow,
  resolveReplyTarget,
} from "./reply-routing.ts";
