// Re-exports a small set of `@agentclientprotocol/sdk` symbols that
// `@agents-js/acp` exposes as part of its host-facing surface. Kept in
// its own file so biome's `assist/source/organizeImports` rule does not
// merge them with the broader untagged re-exports in `connection.ts`.

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionNotification,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";

export type { SessionNotification, SessionUpdate };
export { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION };
