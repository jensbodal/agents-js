---
title: Observability
diataxis: reference
---

# Observability

How agents-js surfaces runtime behavior for debugging, monitoring, and future telemetry integration.

## Current Primitive: Logger + logStore

`@agents-js/acp-host` ships a structured logging system backed by a singleton ring buffer. Every session controller, permission engine, and terminal handler emits `LogEntry` objects through the `Logger` class, which are captured by the global `logStore` for the debug panel.

### LogEntry

Each `LogEntry` carries:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | `number` | Unix epoch ms |
| `category` | `LogCategory` | One of `session`, `permission`, `terminal`, `file`, `error`, `debug`, `mcp-server` |
| `level` | `LogLevel` | One of `debug`, `info`, `warn`, `error`, `silent` |
| `message` | `string` | Human-readable event description |
| `data` | `Record<string, unknown>` | Optional structured payload |
| `sessionId` | `string` | Session ID when available |
| `requestId` | `string` | Request ID when available |

### Logger

The `Logger` class is category-scoped. Each subsystem creates its own instance:

```ts
import { Logger } from "@agents-js/acp-host";

const log = new Logger("session");
log.info("Agent initialized", { agent: "claude", protocolVersion: "0.1" });
```

`Logger` emits to both `console` and the global `logStore`. The `logStore` is a ring buffer (default 500 entries) that the debug panel reads from.

### logStore

```ts
import { logStore } from "@agents-js/acp-host";

// Read all entries
const entries = logStore.getAll();

// Filter by category and level
const errors = logStore.getFiltered(["error"], ["error", "warn"]);

// Subscribe to live entries
const unsub = logStore.subscribe((entry) => {
  console.log(entry.message, entry.data);
});
```

### LogTransport

The `LogTransport` interface lets host applications route log entries to custom backends:

```ts
import { configureLogging, type LogTransport, type LogEntry } from "@agents-js/acp-host";

const transport: LogTransport = {
  handle(entry: LogEntry) {
    // Send to your backend
  },
};

configureLogging({ transports: [transport] });
```

### SpanLogTransport

Groups `LogEntry` objects by `requestId` into `Span` objects, tracking per-request latency:

```ts
import { SpanLogTransport, configureLogging } from "@agents-js/acp-host";

const spanTransport = new SpanLogTransport(100);
configureLogging({ transports: [spanTransport] });

// Retrieve spans
const active = spanTransport.getActiveSpans();
const completed = spanTransport.getCompletedSpans();
```

Each `Span` contains `requestId`, `sessionId`, `startedAt`, `completedAt`, and the full `entries` array.

## Canonical Events

The debug stream covers five canonical event categories:

### 1. Session lifecycle

Emitted by `ACPSessionController` as `ACPSessionEvent` discriminated-union types:

- `status_changed` — status transitions (idle → initializing → ready → prompting → …)
- `session_created` — new session established
- `session_loaded` — existing session loaded
- `session_closed` — session closed
- `session_forked` — session branched
- `session_resumed` — session resumed

Subscribe via `controller.subscribe(listener)`. The listener receives `(event: ACPSessionEvent, state: ACPSessionState)`.

### 2. Tool invocation

Emitted as `tool_call_start` and `tool_call_end` events:

```ts
| { type: "tool_call_start"; toolCallId: string; toolCallName: string; parentMessageId?: string }
| { type: "tool_call_end"; toolCallId: string }
```

The `SessionHooks.onToolCall` hook also receives a `ToolCallSummary` (`{ id, name, status }`) for each invocation.

### 3. Permission decision

Permission requests and resolutions flow through both the event stream and hooks:

- `permission_requested` — agent requests permission, includes the `RequestPermissionRequest`
- `permission_resolved` — user resolves the request, includes cancel state and selected scope
- `SessionHooks.beforePermission` / `afterPermission` — lifecycle hooks for mutating or observing decisions

### 4. Content streaming

Text chunks accumulate in `TurnState.textChunks` during a turn. The `SessionHooks.afterPrompt` hook receives the full `textChunks` array, `stopReason`, and `durationMs` when a turn completes.

### 5. Error/exception

Errors surface through:

- `ACPSessionEvent` type `{ type: "error"; message: string }` — transport-level errors
- `LogEntry` with `level: "error"` and `category: "error"` — structured error logging
- `ACPSessionState.lastError` — the most recent error message on the session state
- `EvalTransport` — collects errors per-request into `EvalRecord.errors[]`

## Session Hooks

`SessionHooks` provides typed lifecycle callbacks for host-side instrumentation:

```ts
export interface SessionHooks {
  beforePrompt?(content: ContentBlock[], sessionId: string | null):
    Promise<ContentBlock[] | undefined> | ContentBlock[] | undefined;
  afterPrompt?(params: {
    sessionId: string | null;
    promptContent: ContentBlock[];
    textChunks: string[];
    stopReason: string;
    durationMs: number;
    requestId: string;
    userMessageId?: string;
    agentMessageId?: string;
  }): Promise<void> | void;
  beforePermission?(request, sessionId): Promise<RequestPermissionRequest | undefined>;
  afterPermission?(request, response, sessionId, selectedScope?): Promise<void> | void;
  onToolCall?(tool: ToolCallSummary, sessionId: string | null): Promise<void> | void;
  onStatusChange?(from: ACPSessionStatus, to: ACPSessionStatus): Promise<void> | void;
}
```

Wire hooks into `StartConfig.hooks` when creating the controller. The A2A mention middleware uses `beforePrompt` for cross-agent dispatch.

## EvalTransport

For evaluation and regression testing, `EvalTransport` captures prompt/response pairs with full metadata:

```ts
import { EvalTransport } from "@agents-js/acp-host";

const evalTransport = new EvalTransport(1000);
configureLogging({ transports: [evalTransport] });
```

Each `EvalRecord` includes `sessionId`, `requestId`, `promptContent`, `responseText`, `stopReason`, `durationMs`, `agentName`, and any associated errors.

## Tool-Call Trace — structured event schema for tool invocations

Logger + logStore capture free-form runtime events. `tool-call-trace`
captures every agent-initiated tool invocation as a **structured event**
with a locked schema, suitable for observability dashboards, replay,
and audit queries.

Shipped in `@agents-js/tools` (see `packages/tools/src/trace.ts`).
Schema at v0.1; backwards-compatible field additions expected over time.

### Record shape

Each `ToolCallTrace` record carries:

| Field | Description |
|-------|-------------|
| `schema_version` | Semver of the schema (`"0.1.0"` today) |
| `event_id` | ULID or UUID v4 unique to this invocation |
| `timestamp` | ISO 8601 wall-clock start time |
| `agent_id` | MXID-shaped identifier of the invoking agent |
| `session_id` | ACP session id, or `null` for direct-emission calls |
| `tool_name` | Canonical name (e.g. `"SpawnAgent"`, `"fetchContext"`) |
| `args` / `result` | Tool input and output, with per-tool redaction applied |
| `status` | `ok` \| `error` \| `timeout` \| `cancelled` \| `in_flight` |
| `duration_ms` | Wall-clock elapsed time |
| `parent_event_id` | Parent invocation for composition chains |
| `root_event_id` | Outermost ancestor for O(1) composition traversal |
| `error` | Populated on non-`ok` status |
| `tags` | Free-form indexing labels |

### Redaction

Tools that take secret-bearing args declare a
`ToolDefinition.redaction` spec. The trace emitter scrubs flagged fields
before persistence — secrets never reach the sink:

```ts
const spec: RedactionSpec = {
  args: ["access_token", "password"],
  result: ["value"],
};
```

Redaction is top-level-only in v0.1; recursive/pattern-based redaction
is a v0.2 concern.

### Usage

```ts
import {
  createJsonlFileSink,
  TraceEmitter,
  wrapToolWithTrace,
} from "@agents-js/tools";

const emitter = new TraceEmitter({
  sink: createJsonlFileSink("/var/log/agents-js/tool-calls.jsonl"),
  agentId: "@my-agent:example.com",
  sessionId: currentSessionId,
});

// Drop-in replacement — original tool.invoke runs unchanged; the trace
// is emitted at the boundary.
const traced = wrapToolWithTrace(tool, emitter);
```

Three built-in sinks ship: `createJsonlFileSink` (append-only file,
serialized writes), `createMemorySink` (tests), and
`createNoopSink` (explicit opt-out). Custom sinks implement the
`TraceSink` interface — one method, `emit(record)`.

### Invariants

- **Observability must not break the agent.** Sink failures log to
  stderr but do not surface to the caller.
- **Tool errors are rethrown.** The emitter observes, does not replace.
- **Storage location is pluggable.** No baked-in defaults; the operator
  picks a sink at wire-up time.

## Debug Panel

The reference browser UI (`apps/web-ui`) includes a debug panel that visualizes the `logStore` stream. It renders `LogEntry` entries filtered by category and level. See [Browser Guide](/surfaces) for setup instructions.

## Telemetry Scope

Current telemetry includes logger transports, browser debug records, tool-call trace sinks,
correlation IDs on gateway control-plane events, and structural audit events for AG-UI,
A2A tasks, registry sync, @mention dispatch, and @@dispatch. JSONL persistence via
`createJsonlFileSink` is the durable sink shipped with tool-call-trace v0.1. Hosts that
need OpenTelemetry, SQLite persistence, or session replay own that integration above the
package primitives.

## Non-goals

- Not building a full observability platform. agents-js provides primitives; backends are the host's responsibility.
- Not prescribing a specific backend. OTel is recommended, but the `LogTransport` interface is backend-agnostic.
- Not adding runtime performance profiling in this cycle. The focus is on session and tool-call visibility.
