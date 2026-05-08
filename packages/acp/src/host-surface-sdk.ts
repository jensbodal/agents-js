// Tagged SDK re-exports — isolated from `connection.ts` so the
// `@hostSurface` JSDoc marker isn't merged by biome's organize-exports
// rule with the untagged `CLIENT_METHODS` / `RequestError` re-exports.
//
// This file's sole job is to re-export the `@agentclientprotocol/sdk`
// symbols that participate in agents-js's documented stable host surface.
// `scripts/docs-reference.ts` walks `packages/acp/src/`, finds the
// `@hostSurface` tag here, and emits the names into
// `docs/_generated/acp-host-stable-surface.md`.

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

/** @hostSurface */
export type { SessionNotification, SessionUpdate };
/** @hostSurface */
export { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION };
