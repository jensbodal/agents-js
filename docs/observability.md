---
title: Observability
diataxis: reference
---

# Observability

How agents-js surfaces runtime behavior for debugging, monitoring, and future telemetry integration.

## Current Primitive: Logger + logStore

`@agents-js/acp-host` ships a structured logging system backed by a singleton ring buffer. Every session controller, permission engine, and terminal handler emits `LogEntry` objects through the `Logger` class, which are captured by the global `logStore` for the debug panel.

The observability surface centers on `Logger`, `logStore`, and the
transports `LogTransport`, `EvalTransport`, and `SpanLogTransport`. The
detailed shape of each is documented below.

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

`ACPSessionController` emits a `ACPSessionEvent` discriminated union for every host-observable transition. Subscribe via `controller.subscribe(listener)`; the listener receives `(event: ACPSessionEvent, state: ACPSessionState)`. The full variant set is the
`type` discriminant of `ACPSessionEvent` in
[`packages/acp-host/src/types/session.ts`](https://github.com/jensbodal/agents-js/tree/main/packages/acp-host/src/types/session.ts);
see the API reference at [/api/](/api/) for the typed union.

`SessionHooks` provides a parallel callback surface for the prompt and permission lifecycles (see below); errors additionally surface through `LogEntry` (`level: "error"`, `category: "error"`), `ACPSessionState.lastError`, and `EvalTransport`'s per-request `errors[]` array.

## Session Hooks

`SessionHooks` provides typed lifecycle callbacks for host-side
instrumentation. The full member set with typed signatures is the
`SessionHooks` interface in
[`packages/acp-host/src/types/hooks.ts`](https://github.com/jensbodal/agents-js/tree/main/packages/acp-host/src/types/hooks.ts);
see the rendered [SessionHooks API reference](/api/) for the typed shape.

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

The `ToolCallTrace` interface defined in `@agents-js/tools`:

<<< @/../packages/tools/src/trace.ts#tool-call-trace{ts}

Field-level format expectations not visible in the TypeScript types
(e.g. `event_id` as ULID/UUIDv4, `timestamp` as ISO 8601, `agent_id`
as MXID-shaped, `schema_version` as semver) are pinned by the schema
spec referenced from the interface JSDoc.

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

> **Correlation ID scope (v0.5):** correlation IDs exist at every surface
> (AG-UI run, A2A task, `@@dispatch` invocation, tool-call trace, JWT `cid`
> claim, bus envelope) but **each surface mints its own**. There is **no
> end-to-end correlation thread today** — an AG-UI run does NOT propagate
> its ID into the underlying ACP turn or tool-call trace records. For
> correlated traces across surfaces, consumers must join on `contextId` or
> `sessionId` rather than `correlationId`. End-to-end threading is a
> separate hardening track.

> **OpenTelemetry adapter: not built-in.** agents-js exposes pluggable
> `LogTransport` / `SpanLogTransport` interfaces (`packages/acp-host/src/logger.ts`)
> and structured audit envelopes (`packages/a2a/src/audit.ts`), but ships
> **no reference OpenTelemetry exporter**. Hosts that want OTel must
> implement an adapter against those interfaces. Recommended minimal
> production sink today: JSONL via `JsonlLogTransport`, or a custom
> transport.

> **Tool-call trace redaction is top-level only.** The `redaction` spec
> applies to top-level object keys. Nested values (objects inside objects,
> secrets inside arrays) are **not** scrubbed. Tool authors emitting nested
> payloads with secrets MUST pre-scrub before returning. Recursive/pattern
> redaction is a v0.2 scope.

## Non-goals

- Not building a full observability platform. agents-js provides primitives; backends are the host's responsibility.
- Not prescribing a specific backend. OTel is recommended, but the `LogTransport` interface is backend-agnostic.
- Not adding runtime performance profiling in this cycle. The focus is on session and tool-call visibility.
