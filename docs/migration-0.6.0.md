# Migrating to the 0.6.0 protocol baseline

The 0.6.0 source baseline forward-migrates every protocol surface agents-js
wraps to its latest release. It is **forward-only**: legacy and compatibility
shims were deleted rather than deprecated, and the published wire shapes changed.
If you consume `@agents-js/*` packages — especially `@agents-js/a2a` and
`@agents-js/a2a-client` — and build from source, this guide is the adaptation
path.

## What changed

| Protocol | SDK | From | To | Impact |
|---|---|---|---|---|
| A2A | `@a2a-js/sdk` | 0.3.13 | **1.0.0-alpha.0** | **Major** — protobuf-canonical data-model rewrite |
| ACP | `@agentclientprotocol/sdk` | 0.21 | **0.24** | Moderate — model-selection removed |
| AG-UI | `@ag-ui/core` | 0.0.53 | **0.0.55** | Minor |
| A2UI | `@a2ui/web_core` | 0.9.2 | **0.10.0** | Minor |

The A2A change is the bulk of the work; the rest of this guide is mostly about it.

## Why A2A is pinned to an alpha

`1.0.0-alpha.0` is the only 1.x release of `@a2a-js/sdk`, published on the `next`
tag. Pinning a baseline to a pre-release is a deliberate, bounded call:

- **Forward-only is the mandate.** The alternative — holding at 0.3.13 and
  treating 1.0 as a later spike — keeps the ecosystem on a wire that upstream
  has already moved off. The decision was to move now and carry any further
  upstream churn forward rather than accrue migration debt.
- **Source baseline, not an npm publish.** This cut is consumed from the
  internal registry by agents that build from source. It is not a public npm
  release. The blast radius is the agents that track this repo, who adapt with
  this guide.
- **Alpha means upstream-breaking-permitted.** A subsequent `1.0.0-alpha.1`
  may change shapes again. The proto-boundary containment below is what keeps
  that churn cheap to absorb.

If a future upstream release stabilizes the 1.x wire, re-pinning is a catalog
bump plus a re-run of the boundary translators — not another rewrite.

## A2A: the data model is now protobuf-canonical

A2A 1.0 replaces the hand-shaped JSON types with the canonical protobuf model
(proto package `lf.a2a.v1`). Discriminator strings are gone; enums replace
string unions; message parts carry a tagged `content` union.

### Enums (import as **values** from `@a2a-js/sdk`)

```ts
import { Role, TaskState } from "@a2a-js/sdk";
```

- `Role.ROLE_USER`, `Role.ROLE_AGENT` — wire JSON `"ROLE_USER"` / `"ROLE_AGENT"`
  (replaces `role: "user" | "agent"`).
- `TaskState.TASK_STATE_SUBMITTED | _WORKING | _COMPLETED | _FAILED |
  _CANCELED | _INPUT_REQUIRED | _REJECTED | _AUTH_REQUIRED` — wire JSON
  `"TASK_STATE_WORKING"` etc. (replaces the lowercase string states).

### Message

```ts
// before (0.3.x)
{ kind: "message", role: "user", parts: [...], messageId }

// after (1.0)
{ messageId, contextId: "", taskId: "", role: Role.ROLE_USER, parts: [...],
  metadata: undefined, extensions: [], referenceTaskIds: [] }
```

- `kind: "message"` removed — delete it everywhere.
- `contextId` / `taskId` are required (`""` when absent).
- `extensions` and `referenceTaskIds` are required arrays.

### Part

```ts
// before
{ kind: "text", text: "hello" }

// after — construct a text part
{ content: { $case: "text", value: "hello" }, metadata: undefined,
  filename: "", mediaType: "text/plain" }

// after — read text from a part
const text = part.content?.$case === "text" ? part.content.value : "";
```

The `content` union is `{$case:"text"|"raw"|"url"|"data", value}`. The old
`{kind:"text"|"file"|"data"}` shapes are gone.

### Task and TaskStatus

```ts
// Task
{ id, contextId, status, artifacts: [], history: [], metadata: undefined }
// TaskStatus
{ state: TaskState, message: Message | undefined, timestamp: string | undefined }
```

- `Task.kind: "task"` removed; `artifacts` is a required array.
- `TaskStatus.state` is the `TaskState` enum.

### TaskStatusUpdateEvent

```ts
{ taskId, contextId, status, metadata: undefined }
```

- Both `kind: "status-update"` **and** `final` are removed.
- **Termination is driven by terminal `TaskState`** (`COMPLETED` / `FAILED` /
  `CANCELED` / `REJECTED`). The SDK closes the SSE stream automatically when a
  terminal state arrives — you no longer set `final: true`.
- Non-terminal progress uses `TASK_STATE_WORKING`. The `metadata` side-channel
  is unchanged.

### AgentCard

The top-level `url` / `protocolVersion` / `preferredTransport` /
`additionalInterfaces` fields are gone, folded into `supportedInterfaces`:

```ts
{
  name, description,
  supportedInterfaces: [
    { url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" }
  ],
  provider: undefined,
  version,
  capabilities: { extensions: [] /* required array */ },
  securitySchemes: {}, securityRequirements: [],
  defaultInputModes, defaultOutputModes,
  skills: [], signatures: [],
}
```

- Read a card's endpoint with `card.supportedInterfaces[0]?.url` (not `card.url`).
- `supportsAuthenticatedExtendedCard` → `extendedAgentCard` (on `capabilities`).

## A2A: JSON-RPC method renames

The wire method names changed. If you build raw JSON-RPC envelopes:

| 0.3.x | 1.0 |
|---|---|
| `message/send` | `SendMessage` |
| `message/stream` | `SendStreamingMessage` |
| `tasks/get` | `GetTask` |
| `tasks/cancel` | `CancelTask` |
| `tasks/resubscribe` | `SubscribeToTask` |
| `tasks/pushNotificationConfig/*` | `Create/Get/List/DeleteTaskPushNotificationConfig` |

## A2A: server-side executors

`eventBus.publish(...)` now takes a wrapped `AgentExecutionEvent`. Import the
`AgentEvent` constructor (a **value**) from `@a2a-js/sdk/server`:

```ts
import { AgentEvent } from "@a2a-js/sdk/server";

eventBus.publish(AgentEvent.task(task));            // a Task
eventBus.publish(AgentEvent.statusUpdate(evt));     // a TaskStatusUpdateEvent
eventBus.publish(AgentEvent.message(msg));          // a Message
eventBus.finished();                                // unchanged
```

`ServerCallContext` is now required:

- `JsonRpcTransportHandler.handle(body, context)` — build one with
  `new ServerCallContext({})` (all opts optional; `requestedVersion` defaults
  to `"0.3"`).
- `DefaultRequestHandler` methods all take a required `context: ServerCallContext`.
- `RequestContext` constructor is reordered to
  `(userMessage, taskId, contextId, context, task?, referenceTasks?)`. Field
  reads (`.userMessage` / `.taskId` / `.contextId` / `.task`) are unchanged.

### Stream-ordering rule (read this)

A2A 1.0's `ResultManager` enforces event ordering on the streaming path. A turn
**must** emit, in order:

1. an initial `AgentEvent.task(...)` in `TASK_STATE_SUBMITTED`,
2. zero or more working `AgentEvent.statusUpdate(...)` in `TASK_STATE_WORKING`,
3. a **terminal `AgentEvent.statusUpdate(...)`** carrying a terminal `TaskState`
   and the reply on `status.message`.

Two ordering violations the manager rejects:

- a second `AgentEvent.task(...)` after the lifecycle is established
  (“Stream ordering violation: received task in task lifecycle stream”), and
- a `statusUpdate` before any initial Message/Task
  (“Received statusUpdate before initial 'Message'/'Task' event”).

A terminal **Task** mid-stream is tolerated by blocking `SendMessage` but
**rejected** on the streaming path — so do not terminate a turn with a Task.
Terminate with a terminal status-update.

One related quirk: `ResultManager.applyStatusUpdate` appends `status.message`
to history and sets the task status, but does **not** copy event-level
`statusUpdate.metadata` onto `task.metadata`. If you need terminal metadata on
the task, attach it to the **initial task**; the intermediate `metadata`
side-channel still rides working status-updates and is consumed live.

## A2A: client-side (`@agents-js/a2a-client`)

- `ClientFactory.createFromUrl(baseUrl, path?)` is **unchanged** — keep your
  existing construction.
- The single-URL `A2AClient` class was removed — use `ClientFactory`.
- Param/result type renames (root `@a2a-js/sdk`):
  - `MessageSendParams` → `SendMessageRequest` (adds required `tenant: string`)
  - `TaskQueryParams` → `GetTaskRequest`
  - `TaskIdParams` → `CancelTaskRequest` / `GetTaskRequest` (by call site)
  - `*PushNotificationConfigParams` → `*PushNotificationConfigRequest`
  - stream result `A2AStreamEventData` → `StreamResponse`
    (`{ payload?: { $case: "task"|"message"|"statusUpdate"|"artifactUpdate", value } }`)
  - `SendMessageConfiguration`: `blocking` → `returnImmediately` (**inverted
    sense**); `pushNotificationConfig` → `taskPushNotificationConfig`.

## Keep proto at the boundary

Translate to and from the proto shapes **only at the A2A wire edge** (your
executor, server, and client transport). Do not let `Role.ROLE_*`, `$case`, or
`TaskState` leak into business logic or behavior tests — keep those in your own
internal terms and translate where they touch the wire. This is what keeps a
later upstream alpha churn contained to the translators.

## ACP 0.21 → 0.24

- Model-selection was removed from the ACP surface. If you consumed
  model-selection types or APIs, drop them.
- Regenerate any vendored ACP schema from the 0.24 SDK.

## acp-host: `AgentConfig.writableFolders` removed

The deprecated `AgentConfig.writableFolders` field is removed. Declare
auto-approved write folders at the session level instead, via
`StartConfig.directoryPolicy.autoApprovedWriteFolders` (or the inline
`StartConfig.autoApprovedWriteFolders`). The write-gate now resolves the
auto-approved set solely from the session directory policy — folders that were
declared only through `writableFolders` will require explicit write approval
until migrated. (Directory policy is a session concern; the agent spawn config
no longer mixes it in.)

## AG-UI 0.0.55 and A2UI 0.10.0

Catalog/pin bumps. If you pinned the prior versions directly, move to the new
ones. Tests that asserted hardcoded `"v0.9"` A2UI literals should read the
version from the SDK rather than re-asserting a string.

## Upgrade checklist

1. Bump `@a2a-js/sdk` to `1.0.0-alpha.0`, `@agentclientprotocol/sdk` to `0.24`,
   `@ag-ui/core` to `0.0.55`, `@a2ui/web_core` to `0.10.0`.
2. Replace `role` / part / state string literals with the enums and the
   `content.$case` part shape.
3. Rename JSON-RPC methods on any raw envelopes.
4. Wrap every `eventBus.publish` in `AgentEvent.task/statusUpdate/message`, and
   thread a `ServerCallContext` through handler calls.
5. Make every streaming turn follow the ordering rule (initial task → working
   updates → terminal status-update).
6. Read agent-card endpoints via `supportedInterfaces[0].url`.
7. Move proto translation to the wire boundary; keep internal logic in your
   own terms.
