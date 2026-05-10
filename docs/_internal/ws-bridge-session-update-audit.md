# WS bridge / acp-host fidelity audit vs ACP SessionUpdate

**Status**: AUDIT COMPLETE — findings documented, fixes proposed as
follow-up tasks. No code changes in this PR.

**Scope**: Cross-check the field set the ACP SDK exposes via
`SessionUpdate` notifications against what reaches the WS bridge
client (browser UI in `apps/web-ui`). Identifies fidelity drops at
each layer boundary so we know which gaps to fix and which are
intentional.

**Layers**:

```
ACP harness  →  acp-host (SessionNotification → ACPSessionState)
             →  WS bridge (ACPSessionEvent + WSBridgeState wrapper)
             →  ws-state-mapper.ts (HostState normalization)
             →  ui-components (acp-chat-app, acp-permission-modal)
```

## ACP `SessionUpdate` enum

Source: `@agentclientprotocol/sdk@0.21.0` schema/types.gen.d.ts:4331.

```ts
SessionUpdate =
  | user_message_chunk
  | agent_message_chunk
  | agent_thought_chunk
  | tool_call
  | tool_call_update
  | plan
  | available_commands_update
  | current_mode_update
  | config_option_update
  | session_info_update
  | usage_update
```

## Variant-by-variant audit

### 1. `user_message_chunk` — DROPPED (intentional)

`acp-host` streaming-translator `default` switch arm. Echo of input
the consumer already has. Documented drop. **No action.**

### 2. `agent_message_chunk` — Cumulative text only

- acp-host: Accumulated into `currentTurn.textChunks: string[]` per `messageId`.
- WS bridge: Reaches client via `WSBridgeState.currentTurn.textChunks`.
- UI: `acp-chat-app` renders the concatenation.

Lossy: ContentBlock variants other than `text` (image, audio,
resource_link, resource) are not represented in `textChunks`. ACP
spec allows non-text agent message chunks; we silently drop them.

**Fix priority**: Low. Most harnesses (claude, opencode, codex) emit
text-only agent messages; the variant is rare. But if a harness
emits an `image` content block in `agent_message_chunk`, the user
sees nothing. Worth a tracker.

### 3. `agent_thought_chunk` — Same as #2

Same accumulator pattern, same variant-loss. Reaches state via
streaming-translator's `thoughtCumulative` map. Currently used by
the TUI's "thinking..." indicator and by the cumulative thought
text on `A2ASessionState.pendingThoughtText`.

Fix priority: Low (same reasoning as #2).

### 4. `tool_call` — **LOSSY** (significant drops)

ACP `ToolCall` shape (SDK types.gen.d.ts:4885):

```ts
ToolCall = {
  toolCallId, title, status, kind?, content?, locations?,
  rawInput?, rawOutput?, _meta?
}
```

acp-host `ToolCallInfo` shape (`packages/acp-host/src/types/session.ts:111`):

```ts
ToolCallInfo = {
  id, name, status, content?: string, kind?: string,
  richContent?: ToolCallContentInfo[]
}
```

| ACP `ToolCall` field | `ToolCallInfo` | Status |
|---|---|---|
| `toolCallId` | `id` | ok |
| `title` | `name` | ok |
| `status` | `status` (mapped enum) | ok |
| `kind` | `kind` | ok (widened to `string`) |
| `content` | `richContent` | **lossy** (see below) |
| `locations` | — | **DROPPED** |
| `rawInput` | — | **DROPPED** |
| `rawOutput` | — | **DROPPED** |

`ToolCallContentInfo` flattens the SDK's `ToolCallContent` discriminated
union but loses fields:

| ACP `ToolCallContent` variant | `ToolCallContentInfo` |
|---|---|
| `content` (text/image/audio/resource_link/resource) | only `text` carried |
| `diff` (path, oldText, newText) | `diffPath`, `diffOldText`, `diffNewText` ok |
| `terminal` (terminalId + session output) | only `terminalId` carried |

**Fix priority**: High. This is the same drop pattern I fixed at the
streaming-translator + A2A wire layer in PR #35-37, but on a
**parallel code path** (acp-host's session-updates.ts builds
`ToolCallInfo` directly from `SessionNotification`, separate from the
streaming-translator). The browser UI sees `ToolCallInfo` via the WS
bridge, so:
- No follow-along (locations dropped)
- No raw I/O display in the permission modal beyond `rawInput`
  (which `ws-state-mapper.ts:34` does grab — but `rawOutput` is
  not even on `ToolCallInfo` to extract)
- Image / audio / resource_link / resource content collapses to text
- Terminal output absent (only terminal session id is forwarded)

**Suggested fix**: Extend `ToolCallInfo` to mirror the SDK's
`ToolCall` shape (the same way `ActiveToolCall` in `a2a-client` was
extended in PR #37). Then update `ws-state-mapper.ts` to forward
the extra fields, and either (a) reuse `acp-tool-call-detail` from
PR #38 in `acp-chat-app` so the browser UI gets full rendering, or
(b) extend `acp-permission-modal` to show the new fields when
the pending permission carries them.

### 5. `tool_call_update` — **LOSSY** (same drops as #4)

Same `ToolCallInfo` reconstruction in session-updates.ts:200. Same
fields dropped (`locations`, `rawInput`, `rawOutput`). Plus mid-call
status transitions don't have a first-class typed `ACPSessionEvent`
variant the way `tool_call_start` / `tool_call_end` do; receivers
observe them via either (a) the generic `session_update` event
carrying the raw `SessionNotification`, or (b) the `state` snapshot
included in every `WSServerMessage { type: "event" }` frame. So the
information is reachable, but a consumer that only handles typed
event-discriminator paths (no state-diff comparison) will miss
intermediate transitions like `pending → in_progress`. A dedicated
`tool_call_progress` typed event would be the cleaner fix.

### 6. `plan` — ok

ACP `Plan.entries: PlanEntry[]` flows through:
- acp-host: `state.plan` (PlanEntryInfo[] — slight rename but same
  shape: content, status, priority).
- ACPSessionEvent: `plan_updated` typed event.
- WS bridge: `WSBridgeState.plan`.
- UI: `acp-plan-panel` renders.

No drops. **No action.**

### 7. `available_commands_update` — ok

Forwarded via `ACPSessionEvent.available_commands_updated` and
`ACPSessionState.availableCommands`. Reaches UI through WS bridge.
No drops. **No action.**

### 8. `current_mode_update` — ok

Forwarded via `ACPSessionEvent.mode_changed` (with full
`SessionModeState`) and `ACPSessionState.modes`. Slight enrichment:
the typed event carries the full available-modes list alongside
the new `currentModeId`, which is more than ACP `CurrentModeUpdate`
provides (it only has `currentModeId`). The host fills in the rest
from session metadata. No drops. **No action.**

### 9. `config_option_update` — INTENTIONALLY DROPPED (translator)

acp-host streaming-translator `default` switch arm. Documented as a
"consumer-state concern handled elsewhere." But there IS a typed
`ACPSessionEvent.config_option_changed` variant with `configId` and
`value: boolean | string` — which means it IS surfaced, just not
through the streaming-translator. The translator doesn't need to
forward it because the controller emits the typed event directly.

**No action**, but worth confirming the typed event path is still
live (one quick grep job for `config_option_changed` consumers).

### 10. `session_info_update` — ok (Phase 1.5)

Forwarded via `ACPSessionEvent.session_info_updated` and
`ACPSessionState.sessionTitle` / `.sessionUpdatedAt`. PR #36 made
this end-to-end through translator + wire + a2a-client. WS bridge
side benefits via `WSBridgeState extends ACPSessionState`. **No
action.**

### 11. `usage_update` — ok

Forwarded via `ACPSessionEvent.usage_updated` (with size, used, cost)
and `ACPSessionState.usage`. SDK-typed `Cost` flows through
verbatim. **No action.**

## Layer-specific findings

### Layer A: acp-host `ToolCallInfo` reconstruction

**`packages/acp-host/src/session-updates.ts:155-225`** — the
`tool_call` and `tool_call_update` switch arms build a minimal
`ToolCallInfo` and discard `locations` / `rawInput` / `rawOutput`.
This is the highest-leverage drop in the audit. Fix is mechanical:
extend `ToolCallInfo` and pass the SDK fields through.

### Layer B: WS bridge wrapper

**`packages/host/src/ws-bridge.ts:44-59`** — `WSBridgeState extends
ACPSessionState` so anything in ACPSessionState reaches the wire.
The WS message types (`event` / `state_snapshot` / `a2ui_message`)
are pure transports — no field-level filtering. So the WS bridge
itself is **not** a drop point; everything flows through. The
fidelity loss happens upstream (Layer A) and downstream (Layer C).

### Layer C: UI mapper

**`packages/ui-components/src/ws-state-mapper.ts`** —
`mapPermissionRequest()` (~lines 27-73) only pulls `title` and
`rawInput` from the host's `pendingPermission.toolCall`. Per-call
detail is otherwise aggregated to counts via
`extractCurrentTurnSummary()` (lines 228-244) — exposes
`toolCallCount`, `activeToolCallCount`, `failedToolCallCount`. No
dedicated completed-count field; no per-call rich payload
propagation. So even if Layer A is fixed to forward the rich
fields, this layer doesn't surface them to per-call render data.

### Layer D: UI components

The new `acp-tool-call-detail` (PR #38) has the full surface but
isn't wired into `acp-chat-app` yet. Phase 3b (acp-transcript
integration) is the natural place to consume the rich fields once
Layers A and C are fixed.

## Proposed follow-up tasks

In dependency order:

1. **Fix Layer A**: Extend `ToolCallInfo` in
   `packages/acp-host/src/types/session.ts` with `locations?`,
   `rawInput?`, `rawOutput?`. Update `session-updates.ts`
   `tool_call` and `tool_call_update` arms to populate them.
   Update `ToolCallContentInfo` to carry full `Terminal` (command,
   exitCode, output) and full content variant fidelity.

2. **Fix Layer C**: Update `ws-state-mapper.ts` to forward the new
   fields onto `HostState.pendingPermission.toolCall` and onto a
   new active/completed tool-call list (rather than just counts).

3. **Layer D follow-up** (after Phase 3b): Render the rich fields
   in `acp-chat-app` using `acp-tool-call-detail` — closes the
   browser-UI parallel of what Phase 3b does for the CLI.

## What this audit does NOT cover

- AG-UI translator (`packages/host/src/acp-to-agui-translator.ts`).
  Different code path with its own translation; should be audited
  separately if AG-UI consumers (apps/web-ui's AG-UI mode) need
  rich tool-call rendering.
- Surface broadcasting / A2UI message forwarding. Those are unrelated
  to ACP SessionUpdate fidelity.
- Performance / payload-size impact of forwarding `rawInput` /
  `rawOutput`. ACP's spec doesn't bound their size; some harnesses
  may produce very large payloads. Suggested fix should at minimum
  consider truncation or out-of-band reference for >N KB values.
