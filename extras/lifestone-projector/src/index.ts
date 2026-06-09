/**
 * `@agents-js/lifestone-projector` — pure render/parse core for the
 * lifestone agent-inbox projection (PROJECTION-SPEC.md). Increment (a):
 * the gateway-row ⇄ lifestone-file logic. The read/write daemon legs
 * (increments b/c) compose this with `@agents-js/claude-channel-adapter`'s
 * `GatewayInboxClient`.
 */

export {
  dedupKey,
  type OutboxParseResult,
  type ProjectedInboxMessage,
  type ProjectedMatrixOrigin,
  parseOutboxFile,
  type RenderedInboxFile,
  renderInboxMessageToFile,
  resolveFrom,
  resolveTimestampMs,
  sanitizeForFilename,
  slugify,
  toCompactStamp,
} from "./render.ts";
