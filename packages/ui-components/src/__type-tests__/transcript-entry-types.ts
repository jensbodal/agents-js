/**
 * Type-only assertions for `TranscriptEntryLike` discriminated union.
 *
 * Lives under `src/` (not `tests/`) so it's covered by the package's
 * `bun run typecheck` step. If `TranscriptEntryLike`,
 * `TranscriptMessageEntryLike`, or `TranscriptToolCallEntryLike` drift
 * out of compatibility with `AcpToolCallDetailData`, these declarations
 * stop compiling.
 *
 * Runtime exports are unused — `tsdown`'s tree-shaking strips this
 * file from the published bundle. Kept as `export const` (rather than
 * just declarations) so it counts as a module to the package bundler.
 */
import type { AcpToolCallDetailData } from "../acp-tool-call-detail.ts";
import type {
  TranscriptEntryLike,
  TranscriptMessageEntryLike,
  TranscriptToolCallEntryLike,
  TranscriptToolCallEntryPayload,
} from "../acp-types.ts";

// Discriminated union narrows correctly on the `kind` discriminator.
function _narrowOnKind(entry: TranscriptEntryLike): string {
  if (entry.kind === "tool_call") {
    // Narrowed to TranscriptToolCallEntryLike — has `toolCall`.
    return entry.toolCall.toolName;
  }
  // Narrowed to TranscriptMessageEntryLike — has `role` and `text`.
  return entry.role + entry.text;
}

// Backwards compat: the original `{ id, role, text }` shape (no
// `kind`) MUST still be a valid `TranscriptEntryLike`.
const _legacyMessage: TranscriptEntryLike = {
  id: "m1",
  role: "user",
  text: "hi",
};

const _explicitMessage: TranscriptMessageEntryLike = {
  id: "m2",
  kind: "message",
  role: "agent",
  text: "ok",
};

const _toolCallEntry: TranscriptToolCallEntryLike = {
  id: "t1",
  kind: "tool_call",
  toolCall: {
    toolCallId: "tc1",
    toolName: "read",
    status: "completed",
    toolKind: "read",
    content: null,
    locations: [{ path: "/a.ts", line: 1 }],
  },
};

// Structural compatibility: `TranscriptToolCallEntryPayload` MUST be
// assignable to `AcpToolCallDetailData` so the transcript can pass
// it into `<acp-tool-call-detail>` without a cast. Drift in either
// shape breaks this assignment.
const _payload: TranscriptToolCallEntryPayload = _toolCallEntry.toolCall;
const _asDetailData: AcpToolCallDetailData = _payload;

// Touch every binding so the file isn't entirely-eliminated by
// tree-shaking before typecheck runs.
export const _typeFixtures = {
  narrow: _narrowOnKind,
  legacyMessage: _legacyMessage,
  explicitMessage: _explicitMessage,
  toolCallEntry: _toolCallEntry,
  payload: _payload,
  asDetailData: _asDetailData,
};
