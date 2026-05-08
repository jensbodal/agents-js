---
title: Protocols
diataxis: reference
---

# Protocols and Schema Alignment

> **Status:** Beta · **Validated by:** package tests, `gateway-e2e`, browser smoke, `docs:build` dead-link gate · **Known limitations:** AG-UI run resumption, A2UI user→agent back-channel contract, third-party A2A interop

`agents-js` is built around explicit protocol and schema boundaries. This page is the canonical map
for what the repo implements directly, what it validates, what it passes through, and where
host-owned extensions begin.

## Standards Map

| Standard / Schema | Role in agents-js | Current posture | Where extensions live |
|---|---|---|---|
| **JSON-RPC 2.0** | Envelope layer under ACP and A2A | Implemented and validated | The repo does not mutate JSON-RPC itself; extensions happen at higher protocol layers |
| **ACP** | Local runtime/session protocol | Implemented and validated | Host-owned permissions, write gates, terminals, workflow state, and workspace policy sit above ACP |
| **A2A** | Remote/browser/CLI protocol | Implemented and validated | ACP-specific metadata is carried in namespaced metadata keys rather than changing the A2A base envelope |
| **MCP** | Tool/context interoperability surface | Passed through and schema-compatible | `agents-js` carries MCP server config through ACP session setup but is not a standalone MCP server/client framework |
| **AG-UI** | Event vocabulary, client workflow semantics, and native transport | Implemented server + client — see [AG-UI](#ag-ui) | Namespaced `CUSTOM` events (`agents-js.*`) carry repo-specific concepts without breaking AG-UI consumers |
| **A2UI** | Agent-authored surface lifecycle over the ACP host adapter seam | Compliant host adapter + renderer plus browser (`apps/web-ui`) and pi-extension host integrations — see [A2UI](#a2ui) | User → agent back-channel rides a namespaced `agents-js.a2ui.surface_event` `CUSTOM` event until the upstream spec lands a contract |
| **Runtime manifests** | Repo-defined validation surface | Implemented and validated | Runtime-specific validators register on top of the generic manifest contract |

A2UI scope: compliant host adapter in `@agents-js/acp-host` plus a renderer in
`@agents-js/a2ui-renderer` targeting the ACP catalog. The user → agent back-channel is
intentionally opaque until the upstream A2UI spec standardizes it.

## Validation and Schema Behavior

The repo keeps schema validation centralized in `@agents-js/validation` and then applies it at the
protocol or host boundary that owns the behavior:

- JSON-RPC, ACP, A2A, agent cards, and runtime manifests all honor the same validation modes:
  `strict`, `loose`, and `filter`
- ACP keeps `_meta` available as the explicit extension pocket while otherwise validating requests,
  responses, and method membership tightly
- runtime manifests stay repo-defined and intentionally small so runtime-specific rules can be
  registered without mutating the transport protocols
- ACP elicitation remains schema-driven, with `@agents-js/schema-utils` and the checked-in hosts
  rendering from the protocol payload instead of inventing a parallel form DSL

## Where `agents-js` Extends the Base Protocols

The repo keeps extensions in named, inspectable seams:

### Host-owned ACP extensions

These are intentionally host concerns, not protocol concerns:

- permission gating
- write-gate approval
- terminal lifecycle management
- workspace identity / cwd / IO-root normalization
- workflow-surface derivation for plan, activity, interrupt, composer, and transcript state

### ACP-over-A2A metadata

When ACP-specific state needs to cross the A2A boundary, it goes through namespaced metadata keys:

- `agentclientprotocol.com/elicitation`
- `agentclientprotocol.com/elicitation-response`
- `agentclientprotocol.com/auth-required`

That keeps the A2A base envelope intact while still carrying ACP-specific continuation state.

### A2A client event normalization

The repo's A2A client adds local semantic events on top of streamed A2A results, but the modeled
event union is broader than the current provider pass-through surface:

- streamed pass-through currently includes the reasoning event family and `tool_call.args`
- the local controller and reducer also use `session.updated` to carry full snapshots or JSON Patch
  deltas
- `message.start`, `message.end`, `step.started`, and `step.finished` are modeled client-side event
  types rather than current provider pass-through claims

Those are repo-owned event-model decisions, not claims that the upstream A2A wire format itself has
changed.

## Alignment Boundaries

The repo implements JSON-RPC, ACP, A2A, AG-UI, and A2UI as first-class wire protocols. AG-UI
was previously in the "alignment only" category and has moved to a compliant native
implementation. A2UI made the same move: the `HostSurfaceAdapter`
seam in `@agents-js/acp-host` and the renderer in `@agents-js/a2ui-renderer` give
agent-authored surfaces a first-class path into the ACP catalog primitives, while the
user → agent back-channel stays intentionally opaque until the upstream A2UI spec
standardizes it. See [A2UI](#a2ui) for the full contract.

---

## JSON-RPC 2.0

`agents-js` uses JSON-RPC 2.0 as the envelope layer underneath ACP and A2A. The repo validates the
generic envelope in `@agents-js/validation`, then layers protocol-specific schema checks on top in
ACP and A2A. It does not define a custom JSON-RPC dialect.

### Where It Appears

JSON-RPC shows up in a few concrete places:

- `@agents-js/validation` exports `validateJsonRpcEnvelope`, `jsonRpcRequestSchema`, and
  `jsonRpcResponseSchema`
- `@agents-js/acp` communicates with agent processes over stdio/NDJSON and uses JSON-RPC envelopes
  for ACP requests and responses
- `@agents-js/a2a` exposes ACP-backed agents as HTTP JSON-RPC + SSE endpoints
- `@agents-js/acp-host` builds host behavior on top of ACP, but does not change the JSON-RPC layer
- the repo's smoke and integration tests exercise both ACP and A2A request/response paths through
  JSON-RPC envelopes

If you are embedding `agents-js`, JSON-RPC is the lowest shared contract you need to preserve before
you add ACP, A2A, or host-specific behavior.

### Envelope Rules

The generic validator is intentionally small:

- requests must set `jsonrpc: "2.0"` and a non-empty `method`
- request `id` values are optional and may be a string, number, or `null`
- responses must set `jsonrpc: "2.0"` and include an `id`
- responses must contain exactly one of `result` or `error`
- errors carry `code`, `message`, and optional `data`

`validateJsonRpcEnvelope(input, kind, options)` supports the repo's validation modes
(`strict`, `loose`, and `filter`). Invalid request envelopes surface a `ValidationError` with
`jsonRpcCode: -32600`; protocol-specific validators can use `-32602` for invalid params.

```ts
import { validateJsonRpcEnvelope } from "@agents-js/validation";

const request = validateJsonRpcEnvelope(rawMessage, "request");
const response = validateJsonRpcEnvelope(rawMessage, "response");
```

Use the generic validator first when you need to accept or reject transport frames before deciding
which protocol-specific schema to apply.

### ACP On Top

ACP is the local runtime/session protocol that sits directly on top of JSON-RPC.

- `@agents-js/acp` owns the transport/controller layer
- `@agents-js/validation` validates ACP envelopes, methods, requests, and responses
- `validateACPMethod` enforces the method whitelist from `@agentclientprotocol/sdk`
- `validateACPRequest` requires a method, rejects ids on notification methods, and validates
  `params` against generated ACP schemas
- `validateACPResponse` validates the matching response schema for the method and accepts protocol
  errors without rewriting them

ACP uses the JSON-RPC envelope for transport, but the protocol contract becomes stricter after that:

- request/response shape is checked against ACP's method set
- request `params` and response `result` are schema-validated per method
- host-owned behavior such as permissions, terminals, write gates, workspace policy, and elicitation
  lives above ACP rather than inside JSON-RPC itself
- ACP-specific continuation data stays in ACP-defined extension fields and metadata, not in the
  base JSON-RPC envelope

The important boundary for embedders is that JSON-RPC carries the frame, ACP carries the protocol.

### A2A On Top

A2A uses JSON-RPC as the request/response envelope for the gateway and client surfaces.

- `validateA2ARequest` calls the generic JSON-RPC request validator first, then validates
  method-specific payloads for `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`,
  `tasks/resubscribe`, `agent/getAuthenticatedExtendedCard`, and push-notification config methods
- `validateA2AResponse` starts with the generic JSON-RPC response validator and then validates the
  streamed result shape when the response carries an A2A event payload
- `@agents-js/a2a` serves the protocol over HTTP and SSE, but it does not change the JSON-RPC
  envelope rules

That split matters when you are integrating with the reference gateway:

- JSON-RPC tells you whether the frame is structurally valid
- A2A schema validation tells you whether the protocol payload is valid
- gateway-specific behavior such as streaming, task state, and push-notification config is layered
  above the envelope

### What `agents-js` Does Not Extend Here

JSON-RPC itself stays standard in this repo.

- there is no repo-specific JSON-RPC method dialect
- there are no custom JSON-RPC envelope fields
- the repo does not use JSON-RPC for runtime manifests, UI component schemas, or host workflow state
- extension data is carried in ACP metadata, A2A payloads, or host-owned schemas, not by changing
  the JSON-RPC protocol

That is the line to keep in mind when adding new features: if the change belongs to the transport
frame, it needs to stay JSON-RPC-compatible; if it belongs to the protocol payload, it should be
validated one layer up.

### Before You Embed Or Integrate

If you are building on top of `agents-js`, validate in this order:

1. Check the JSON-RPC envelope with `validateJsonRpcEnvelope`.
2. Apply the protocol validator for the layer you are using:
   - `validateACPRequest` / `validateACPResponse` for ACP
   - `validateA2ARequest` / `validateA2AResponse` for A2A
3. Handle host-specific concerns separately from the wire contract:
   - permissions
   - terminals
   - file IO
   - elicitation
   - workspace policy

If you only need the transport contract, stop at JSON-RPC. If you need the actual protocol, move up
to ACP or A2A validation rather than extending the envelope.

---

## ACP

> **Name collision note:** The Agent Communication Protocol (ACP), originally developed by IBM, was merged into the Agent2Agent (A2A) protocol in September 2025. The "ACP" this repo implements is Zed's Agent Client Protocol, a separate local stdio/JSON-RPC spec for spawning and interacting with coding agents. These are unrelated protocols that share an acronym.

`agents-js` uses ACP as the local runtime/session protocol for managed agent execution.
This section describes the ACP surface that the repo implements, validates, and extends through host
code.

### Package Ownership

| Package | Role |
|---|---|
| `@agents-js/acp` | Low-level ACP client controller and stdio/NDJSON transport |
| `@agents-js/acp-host` | Host session orchestration on top of ACP: permissions, write gates, terminals, elicitation, workspace context |
| `@agents-js/validation` | ACP envelope, method, request, response, and schema validation |
| `@agents-js/ui-components` | Host-rendered ACP UI surfaces such as elicitation forms, permission dialogs, and write-gate modals |

### Validated ACP Surface

The ACP validator in `@agents-js/validation` works against the SDK-defined method set via
`ACP_METHOD_WHITELIST`.

The repo validates:

- JSON-RPC 2.0 ACP envelopes via `validateACPEnvelope`
- ACP method membership via `validateACPMethod`
- ACP requests via `validateACPRequest`
- ACP responses via `validateACPResponse`
- ACP form elicitation metadata via `ACPFormElicitationMetadata`

!!!include(_generated/acp-validated-surface.md)!!!

Validation supports the repo-wide modes:

- `strict`
- `loose`
- `filter`

ACP envelopes are strict about the JSON-RPC shape, but the validation layer keeps `_meta` available
as the extension pocket for ACP-scoped metadata.

### Session Lifecycle

The session controller in `@agents-js/acp-host` composes the transport controller with host
policy and lifecycle state.

The core lifecycle methods are:

- `start(...)`
- `newSession()`
- `loadSession(...)`
- `prompt(...)`
- `cancel()`
- `forkSession()`
- `closeSession()`
- `destroy()`

At the transport layer, ACP session interactions include the SDK-defined agent/client method set
such as:

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/close`
- `session/fork`
- `session/resume`
- `session/set_config_option`
- `session/set_mode`
- `session/set_model`
- permission request and response flows
- elicitation request and response flows

`ACPSessionController` is the host-facing orchestration layer. It is the place where ACP
session state becomes an application-level session model with prompt queueing, turn tracking,
permission state, write-gate state, and optional persistence.

### Elicitation And Forms

ACP elicitation is schema-driven. The validation layer exposes
`ACPFormElicitationMetadata`, which carries:

- `kind: "acp.elicitation"`
- `mode: "form"`
- `requestedSchema`
- `message`
- `sessionId`

That schema metadata is the contract the host uses to render forms. In `agents-js`, the host
stack parses and renders that structured schema rather than inventing a separate form DSL.

The host-side elicitation boundary is:

- ACP defines the request and response shape
- `@agents-js/acp-host` owns the elicitation adapter surface and state management
- `@agents-js/ui-components` renders the form UI in checked-in hosts

### Permission And Write Gates

ACP carries permission and write-gate behavior through the host session loop, but the policy and
UI are host-owned.

`@agents-js/acp-host` handles:

- permission evaluation and remembered-rule lookup
- write-gate approval requests
- terminal lifecycle management
- workspace-context normalization for policy and process launch

The host event model reflects both protocol events and host-owned decisions:

- `permission_requested`
- `permission_resolved`
- `write_gate_requested`
- `write_gate_resolved`
- `writable_folder_added`
- `elicitation_requested`
- `elicitation_resolved`

In practice, ACP provides the protocol-shaped request/response flow, while the host decides how
to present, persist, and apply the result.

### Protocol Vs Host-Owned Behavior

ACP is the protocol layer. Host concerns sit above it.

ACP-owned behavior:

- JSON-RPC envelopes
- request/response validation
- method whitelisting
- session lifecycle messages
- elicitation payloads
- protocol-scoped metadata carried in `_meta`

Host-owned behavior:

- permission policy
- write review UX
- terminal management
- workspace identity and session cwd normalization
- read/write root policy
- scratch-root handling
- session persistence

The split matters because it keeps ACP portable while allowing `agents-js` to provide a richer
managed-host experience on top.

---

## A2A

`agents-js` uses A2A as the outward-facing protocol for the reference gateway and client stack.
The repo exposes ACP runtimes over HTTP and SSE, publishes an agent card for discovery, and keeps
the protocol surface narrow enough that the A2A envelope stays standard while repo-specific
behavior lives in explicit extension seams.

### Package ownership

- `@agents-js/a2a` owns the gateway side: agent-card discovery,
  ACP-to-A2A execution, HTTP/SSE transport, and the reference server wrapper.
- `@agents-js/a2a-client` owns the client side:
  agent-card resolution, target probing, message/task transport, session reduction, and metadata
  normalization.

The gateway is built by `serveACPOverA2A(...)`, which spawns an ACP agent, wraps it in
`ACPtoA2AExecutor`, and serves it through `UniversalA2AServer`. The server exposes
`/.well-known/agent-card.json` and dispatches JSON-RPC requests over POST.

### Agent cards

`buildAgentCard(...)` provides the gateway card shape used by the reference server. The defaults are
deliberately simple:

- `url`: `http://127.0.0.1`
- `version`: `1.0.0`
- `protocolVersion`: `0.3.0`
- `defaultInputModes`: `["text"]`
- `defaultOutputModes`: `["text"]`
- empty `skills` and `capabilities`

`mapCapabilities(...)` enriches the card after ACP initialization. In this repo it currently marks
`streaming = true`, sets `multimodal = true` when the ACP runtime advertises image prompt support,
and copies discovered prompts or resources into the A2A card when requested.

### JSON-RPC over HTTP and SSE

The gateway validates A2A requests and responses before and after dispatch. Standard JSON-RPC
remains the envelope layer; `agents-js` does not define a custom JSON-RPC dialect.

Request handling follows two paths:

- regular POST requests return standard JSON-RPC responses
- POST requests with `Accept: text/event-stream` stream JSON-RPC envelopes as SSE `data:` frames

The server-side bridge currently supports these user-facing A2A methods:

- `message/send`
- `message/stream`
- `tasks/get`
- `tasks/cancel`
- `tasks/resubscribe`

The gateway also supports push-notification config CRUD and authenticated extended-card retrieval at
the SDK/server layer, but the turn/task methods above are the core user-facing bridge.

For the full set of registered A2A schemas (request/response shapes
and named validators), see
[`packages/validation/src/a2a.ts`](https://github.com/jensbodal/agents-js/tree/main/packages/validation/src/a2a.ts)
(`a2aValidationSchemas`).

### Streaming behavior

Streaming is task-backed rather than raw ACP chunk forwarding. The bridge emits JSON-RPC envelopes
that wrap A2A task events, and the client stack can either consume them live or resume an in-flight
task through `tasks/resubscribe`.

In practice this means:

- `message/send` remains available for non-streaming clients
- `message/stream` returns `text/event-stream`
- streamed turns may begin with a submitted task, continue through working status updates, and end
  with a final task snapshot
- `tasks/resubscribe` reattaches to the same task-backed stream shape

The reference client prefers streaming when the target advertises it. The CLI and browser surfaces
both consume this same task-backed stream model.

### ACP-over-A2A metadata seams

ACP-specific continuation state does not change the A2A base envelope. Instead, it travels through
namespaced metadata keys:

- `agentclientprotocol.com/elicitation`
- `agentclientprotocol.com/elicitation-response`
- `agentclientprotocol.com/auth-required`

That keeps elicitation and auth continuation visible to the client while preserving the standard
A2A request and response shapes.

### Repo-specific normalization

The A2A protocol itself is not responsible for several behaviors that `agents-js` layers on top:

- the gateway translates ACP `agent_message_chunk` updates into A2A task status updates
- the gateway turns ACP form elicitation into A2A `input-required` task state with ACP metadata
- auth-required continuation is represented as task state plus namespaced metadata, not a custom
  A2A base method
- the client reducer normalizes streamed events and local client notifications into session state,
  including `message.delta`, reasoning events, `tool_call.args`, and `session.updated`; the typed
  local event model also includes message and step lifecycle events for hosts that emit them
- agent-card shaping, capability detection, and target probing are client/gateway conveniences, not
  A2A wire changes

That is the main boundary to remember when embedding `agents-js`: A2A stays standard at the wire
layer, while the repo owns the gateway, client, and session semantics around it.

### Mention-dispatch in practice

A2A is also the wire protocol that powers cross-host `@mention` delegation in `agents-js`. When a
user types `@other-agent` in a prompt, the host's `beforePrompt` middleware (from
`@agents-js/a2a-client`) issues a blocking, non-streaming `message/send` to the remote agent and
injects the reply into the user's turn. The middleware is hardcoded to `stream: false` — the user
sees the delegated agent's final answer, not its intermediate thinking.

This is a deliberate choice at the mention-dispatch layer and is distinct from A2A's protocol-level
streaming story above: `message/stream` remains available for direct clients of the gateway, but
`createA2AMentionMiddleware` in `packages/a2a-client/src/middleware.ts` never takes that path. The
dispatched answer is wrapped in an `<a2a-delegation-response>` block so the receiving LLM treats it
as the authoritative reply from the mentioned agent.

See [Multi-agent patterns](/surfaces#multi-agent-patterns) for the end-to-end setup and
[Agent registry](/surfaces#agent-registry) for the file format that hosts use to resolve mention targets.

---

## MCP

`agents-js` carries MCP through ACP session setup and MCP-compatible content shapes. The repo
treats MCP as an interoperability seam, not as a standalone MCP client/server framework or
transport runtime.

### Where MCP Enters The Stack

MCP enters the stack in two concrete places:

- `@agents-js/acp` passes `mcpServers` through the supported ACP session lifecycle methods:
  `newSession`, `loadSession`, `forkSession`, and `resumeSession`
- `@agents-js/acp-host` builds the session MCP list from `StartConfig.mcpServerUrl` and
  `StartConfig.mcpServerName` via `buildMcpServersList(...)`

The host helper currently emits a single HTTP MCP server entry when a URL is present. It uses the
caller-provided display name when available and defaults to `"workspace"`.

### What This Repo Carries Through

The repo owns the carried-through behavior around MCP, not the MCP protocol itself:

- `ACPClientController` preserves `mcpServers` on the relevant session methods and defaults them
  to `[]` when omitted
- `@agents-js/validation` validates ACP session schemas that require `mcpServers`
- the generated ACP schema documents MCP transport variants such as HTTP, SSE, and stdio
- ACP content remains compatible with MCP-originated content blocks, so hosts can forward
  structured content without inventing a repo-specific transformation layer
- `CapabilityCache` tracks agent-advertised `mcpCapabilities` separately from workspace capability
  flags tied to whether a local MCP server URL is available

That is enough for hosts to pass MCP configuration into ACP and keep MCP-shaped content moving
through the stack, but it remains a compatibility surface rather than a new protocol layer.

### What `agents-js` Does Not Claim

`agents-js` does not claim to be:

- a generic MCP client or server framework
- a complete MCP transport/runtime implementation
- the source of truth for MCP discovery, registry, UI, or arbitrary server orchestration

MCP appears here only where it intersects ACP session setup, capability signaling, and content
compatibility. It is not the protocol used by the browser app, CLI, or A2A gateway surfaces.

### Guidance For Host Integrators

If you are wiring an MCP-capable backend into `agents-js`, treat MCP as configuration and content
compatibility:

1. pass MCP server details through ACP session setup
2. let host code decide how to surface or persist that configuration
3. keep transport validation on ACP and JSON-RPC, not on an MCP-specific overlay

For embedding guidance, see [ACP Host Embedding](/harness-guide).

---

## AG-UI

`agents-js` ships a native AG-UI server and client. The repo implements the AG-UI
wire contract end-to-end: the reference gateway accepts `POST /agent` with a `RunAgentInput`
body and streams canonical `@ag-ui/core` events over SSE, and the `@agents-js/a2a-client`
package ships a first-party AG-UI transport that speaks the same contract.

This section is the compliance reference. The older posture — "semantic alignment only, A2A
JSON-RPC on the wire" — still applies to the classic A2A client stack, but AG-UI itself is now
a directly supported protocol in addition to that.

### Posture

- **Server**: `POST /agent` on the internal gateway accepts `RunAgentInput` and returns a
  `text/event-stream` of UPPER_SNAKE_CASE AG-UI events validated against `@ag-ui/core`
  `EventSchemas`.
- **Client**: `AGUITransport` in `@agents-js/a2a-client` issues `POST /agent` requests,
  parses SSE frames, validates each event, and exposes them to consumers. An
  `AguiToA2ATransportAdapter` lets existing A2A-shaped consumers drive AG-UI endpoints.
- **Vocabulary**: canonical AG-UI event names (UPPER_SNAKE_CASE) are the wire names.
  Legacy agents-js lowercase event names are still emitted on the A2A JSON-RPC path and in
  the locally-modeled reducer events; they are not the AG-UI wire names.
- **Validation**: always-on, both sides, via `validateAguiEvent` from
  `@agents-js/validation`. A malformed event is a protocol error, not a silent drop.

### HTTP Contract

The AG-UI endpoint is `POST ${baseUrl}/agent`.

- Request body: `RunAgentInput` JSON as defined by `@ag-ui/core`.
- Request headers: `Content-Type: application/json`, `Accept: text/event-stream`.
- Response: `text/event-stream` with `data: <json>\n\n` frames, one AG-UI event per frame.
- Response status: `200` on accepted stream, `400` on malformed `RunAgentInput`, `406` when
  `Accept` does not include `text/event-stream`.

Each SSE `data:` payload is a JSON-encoded event whose `type` is one of the UPPER_SNAKE_CASE
values from the `@ag-ui/core` `EventType` enum (enumerated below). Events are validated
against the matching schema in `@ag-ui/core`'s `EventSchemas` before being written to the
stream and again when the client parses them.

#### Example request

```http
POST /agent HTTP/1.1
Host: gateway.example.internal
Content-Type: application/json
Accept: text/event-stream

{
  "threadId": "thread_01H...",
  "runId": "run_01H...",
  "messages": [
    { "id": "msg_1", "role": "user", "content": "summarize ./README.md" }
  ],
  "tools": [],
  "context": [],
  "state": {},
  "forwardedProps": {}
}
```

If `threadId` is omitted, the server generates one and echoes it back inside the initial
`RUN_STARTED` event. `runId` is server-authoritative — if the caller supplies one, the
server may replace it. Clients should always read `threadId` and `runId` from `RUN_STARTED`
rather than assuming the request values survive.

#### Example response

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive

data: {"type":"RUN_STARTED","threadId":"thread_01H...","runId":"run_01H..."}

data: {"type":"TEXT_MESSAGE_START","messageId":"msg_2","role":"assistant"}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg_2","delta":"The README "}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg_2","delta":"describes ..."}

data: {"type":"TEXT_MESSAGE_END","messageId":"msg_2"}

data: {"type":"RUN_FINISHED","threadId":"thread_01H...","runId":"run_01H..."}

```

### Run Lifecycle

Every stream follows the same lifecycle shape:

1. The first event on the stream is always `RUN_STARTED`. It carries the authoritative
   `threadId` and `runId`.
2. The body of the run is any mix of AG-UI event types — text, tool call, reasoning, state,
   step, custom.
3. The last event on the stream is either `RUN_FINISHED` (successful completion) or
   `RUN_ERROR` (recoverable or fatal error reported in-band).

The server closes the SSE stream after the terminal event. Clients that see the stream close
before a terminal event should treat it as a transport error and surface that to the caller;
the client transport itself does not synthesize a terminal event in that case.

#### Errors

- **Request-time** errors (invalid JSON, missing fields, unsupported `Accept`) return HTTP
  `400` or `406` with a JSON error body. No stream is opened.
- **Stream-time** errors are reported as a `RUN_ERROR` event and end the stream. `RUN_ERROR`
  carries a `message` and optional `code`.

Clients should treat the absence of `RUN_FINISHED`/`RUN_ERROR` as an incomplete run.

### Supported Event Types

The server and client implement the full canonical set from `@ag-ui/core@0.0.52` (27
event types), plus a namespaced `CUSTOM` extension family for agents-js-specific events
that do not map cleanly to a canonical AG-UI event.

#### Canonical AG-UI events

Lifecycle:

- `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- `STEP_STARTED`, `STEP_FINISHED`

Text messages:

- `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TEXT_MESSAGE_CHUNK`

Tool calls:

- `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_CHUNK`,
  `TOOL_CALL_RESULT`

Reasoning:

- `REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`,
  `REASONING_MESSAGE_END`, `REASONING_MESSAGE_CHUNK`, `REASONING_END`,
  `REASONING_ENCRYPTED_VALUE`

Deprecated thinking aliases retained for back-compat with older AG-UI consumers:

- `THINKING_START`, `THINKING_END`, `THINKING_TEXT_MESSAGE_START`,
  `THINKING_TEXT_MESSAGE_CONTENT`, `THINKING_TEXT_MESSAGE_END`

State:

- `STATE_SNAPSHOT`, `STATE_DELTA`, `MESSAGES_SNAPSHOT`

Activity and raw:

- `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA`, `RAW`

Extension:

- `CUSTOM`

All 27 event type names, schemas, and field shapes come from `@ag-ui/core` via
`@agents-js/agui-types`. agents-js does not maintain a parallel schema table.

#### agents-js `CUSTOM` namespace

agents-js uses `CUSTOM` events with a namespaced `name` of the form `agents-js.<kind>` to
carry concepts that the canonical AG-UI event set does not cover. These ride the same
`CUSTOM` schema (`{ type: "CUSTOM", name: string, value: unknown }`) and are validated as
plain `CUSTOM` events; the namespacing is a convention, not a schema change.

Currently-defined namespaced custom events include:

- `agents-js.stop_reason` — terminal reason codes (`completed`, `canceled`, `turn_limit`,
  `policy_denied`, etc.) that do not fit cleanly into `RUN_FINISHED.result`.
- `agents-js.plan` — host-owned plan surface updates produced by the ACP layer.
- `agents-js.mode_changed` — permission-mode transitions (e.g., `plan` → `accept_all`).
- `agents-js.usage` — token/cost accounting where the upstream runtime exposes it.
- `agents-js.permission_request`, `agents-js.permission_response` — ACP permission gating
  events surfaced through the AG-UI stream.
- `agents-js.elicitation_request`, `agents-js.elicitation_response` — ACP elicitation
  requests and answers.
- `agents-js.write_gate_request`, `agents-js.write_gate_response` — write-gate approval
  events.

Consumers that only speak canonical AG-UI can ignore `CUSTOM` events with an unknown
`name` and still see a coherent run. Consumers that know about the `agents-js.*`
namespace can use these to drive permission, plan, and write-gate UI without reaching
below the AG-UI transport.

### Client Usage

The client transport lives in `@agents-js/a2a-client` and is designed to be dropped in
either as a native AG-UI client or as a shim behind existing A2A-client code.

#### Native AG-UI consumer

```ts ignore
import { AGUITransport } from "@agents-js/a2a-client";

const transport = new AGUITransport({ baseUrl: "https://gateway.example.internal" });

for await (const event of transport.runAgent({
  threadId: undefined, // let the server assign
  messages: [{ id: "msg_1", role: "user", content: "hello" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
})) {
  // event.type is a canonical UPPER_SNAKE_CASE AG-UI type, already validated.
  handleAguiEvent(event);
}
```

`AGUITransport` handles SSE framing, JSON parsing, per-event schema validation, and
lifecycle enforcement (first event is `RUN_STARTED`, terminal is `RUN_FINISHED` or
`RUN_ERROR`). Consumers receive only validated events.

#### Adapter for existing A2A-client code

`AguiToA2ATransportAdapter` wraps an `AGUITransport` so it presents the same
`A2ATransport` interface used by the rest of the client stack:

```ts ignore
import { AGUITransport, AguiToA2ATransportAdapter } from "@agents-js/a2a-client";

const aguiTransport = new AGUITransport({ baseUrl });
const a2aCompatibleTransport = new AguiToA2ATransportAdapter(aguiTransport);

// Hand the adapter to code that already speaks A2ATransport.
const controller = createControllerFromTransport(a2aCompatibleTransport);
```

The adapter translates AG-UI events into the A2A-client-shaped events the reducer already
understands, so session reduction, `session.updated` notifications, and tool-call state
keep working without a rewrite.

### Validation

Validation is always on, on both sides, and is not configurable.

- **Server**: every outgoing AG-UI event is validated against `@ag-ui/core` `EventSchemas`
  via `validateAguiEvent` (from `@agents-js/validation`) before the SSE frame is
  written. A validation failure is surfaced as a `RUN_ERROR` and closes the stream.
- **Client**: every incoming SSE frame is validated before it is yielded to the
  consumer. A validation failure is a protocol error and closes the transport.

`validateAguiEvent` is the single gate. It narrows the event type and guarantees that any
downstream code only sees a canonical AG-UI shape. There is no "loose mode" for AG-UI —
the wire contract is strict.

See `packages/validation/README.md` for the general validation surface. See
`packages/agui-types/README.md` for the canonical schemas, adapters, and exact pin of
`@ag-ui/core`.

### Known Limitations

The current implementation is a compliant implementation of the core AG-UI contract. Several
expected-but-not-yet-shipped capabilities are intentionally out of scope:

- **Single in-flight prompt per gateway process.** The reference gateway backs AG-UI
  requests with a shared `HostSession` singleton. Issuing a second `POST /agent` while an
  earlier run is still streaming is rejected with HTTP 409 before the SSE stream opens.
  Multi-tenant deployments should run one gateway process per concurrent run.
- **No AG-UI resume.** The spec does not currently define a resume/reattach operation for
  runs. agents-js does not ship one either. A disconnected client must start a new run.
  The existing A2A `tasks/resubscribe` path is unchanged, but it is an A2A feature, not an
  AG-UI one.
- **No per-thread multi-session isolation.** `threadId` is echoed correctly on every
  run, but the gateway does not maintain per-thread state across runs — each `POST /agent`
  is an independent session from the gateway's point of view.
- **A2UI surface lifecycle is not part of AG-UI.** Dynamic agent-authored UI surfaces remain
  host-owned and are not transported over AG-UI events.

### Repo Evidence

- `packages/a2a-client/src/transports/agui.ts` — `AGUITransport`
- `packages/a2a-client/src/transports/agui-a2a-adapter.ts` — `AguiToA2ATransportAdapter`
- `apps/internal-gateway/` — `POST /agent` endpoint and ACP-to-AG-UI translator
- `packages/agui-types/` — canonical `@ag-ui/core` re-exports and adapter helpers
- `packages/validation/` — `validateAguiEvent` and related validators

---

## A2UI

`agents-js` ships a native A2UI host adapter and renderer on top of
`@a2ui/web_core@0.9.1-alpha.0`. The repo implements the A2UI surface lifecycle
end-to-end: `@agents-js/a2ui-host/acp-host` turns ACP tool-call content into
validated `HostSurfaceAdapter` messages, the reference gateway relays those messages to
browser clients over the existing AG-UI SSE stream, and `@agents-js/a2ui-renderer` maps
the resulting component trees onto the existing `acp-*` Lit primitives.

The current implementation wires that surface lifecycle into the shipped hosts: `apps/web-ui` is the browser
reference renderer and `extras/pi-extension` forwards surface events through its existing
`onProgress` callback.

This section is the compliance reference. The earlier posture — "component-vocabulary alignment
only, no surface transport" — no longer describes the shipped state. The `@agents-js/ui-components`
primitives are still host-owned; The current implementation adds an agent-authored surface path that targets those
same primitives through a published catalog.

### Posture

- **Host adapter**: `@agents-js/a2ui-host/acp-host` exposes the
  `HostSurfaceAdapter` interface and `createA2uiToolCallContentHandler()` bridge. Hosts
  implement the adapter and register the bridge in the acp-host
  `toolCallContentHandlers` pipeline. The adapter receives validated `A2uiMessage`
  values and owns render/update/delete of its own surface state.
- **Renderer**: `@agents-js/a2ui-renderer` consumes a `SurfaceModel` and returns a Lit
  `TemplateResult`, binding component IDs in the ACP catalog to the matching `acp-*`
  primitives. Hosts embed the renderer directly or drive the primitives themselves.
- **Gateway**: the reference gateway forwards A2UI messages as AG-UI `CUSTOM` events with
  `name = "agents-js.a2ui.surface_event"` on the existing `/agent` SSE stream. User →
  agent events travel back through the same namespaced channel.
- **Validation**: always-on on both sides, via `validateA2uiMessage` from
  `@agents-js/validation`. Inbound messages and host-emitted events both pass the gate. A
  malformed message is a protocol error, not a silent drop.

### Supported Messages

The host adapter and renderer handle the four surface-lifecycle messages defined by
`@a2ui/web_core@0.9.1-alpha.0`:

- `CreateSurface` — opens a new surface for the session. Carries the initial component tree,
  the data model, and the catalog ID the surface expects to render against.
- `UpdateComponents` — partial component-tree update. Components not named in the update
  are preserved.
- `UpdateDataModel` — partial data-model update. Binds back into previously-rendered
  components without requiring a tree replacement.
- `DeleteSurface` — closes a surface and releases host state. The host adapter is expected
  to tear down any rendered view at this point.

Each message is validated against the `@a2ui/web_core` schema via `validateA2uiMessage`
before it reaches the adapter or the renderer. The validator is the single gate; there is no
loose mode.

### Catalog

agents-js publishes one A2UI catalog: the ACP catalog. Its canonical ID is:

```
https://agents-js.bodal.dev/catalog/acp/0.1
```

The ACP catalog defines 15 components, each backed by a matching `acp-*` Lit primitive
in `@agents-js/ui-components`:

- `acp-row` — horizontal layout container.
- `acp-column` — vertical layout container.
- `acp-divider` — visual separator.
- `acp-image` — image display with sizing and alt-text attributes.
- `acp-icon` — iconographic display with size and color attributes.
- `acp-button` — interactive button, emits a user event on click.
- `acp-text-field` — single-line text input bound to the data model.
- `acp-checkbox` — boolean input bound to the data model.
- `acp-slider` — numeric range input bound to the data model.
- `acp-choice-picker` — enumerated-choice input bound to the data model.
- `acp-date-time-input` — date/time input bound to the data model.
- `acp-modal` — dismissible overlay container.
- `acp-message` — agent/user message bubble.
- `acp-streaming-text` — incremental text surface for streamed deltas.
- `acp-status-bar` — compact status/metadata strip.

The catalog ID is advertised by the renderer and expected by the host adapter. Surfaces
that reference an unknown catalog ID are rejected at validation time.

### Host Integration

Hosts plug into the adapter seam by registering the A2UI tool-call content handler with
`@agents-js/acp-host`:

```ts ignore
import { ACPSessionController } from "@agents-js/acp-host";
import {
  createA2uiToolCallContentHandler,
  type HostSurfaceAdapter,
} from "@agents-js/a2ui-host/acp-host";

const surfaceAdapter: HostSurfaceAdapter = {
  handleSurfaceMessage(message) {
    /* render, update, or delete surface state */
  },
  handleSurfaceClosed(surfaceId) {
    /* release host-owned resources */
  },
};

const controller = new ACPSessionController();
await controller.start({
  // ...other config...
  toolCallContentHandlers: [createA2uiToolCallContentHandler({ surfaceAdapter })],
});
```

`@agents-js/acp-host` drives the handler from `ACPSessionController`'s existing
tool-call content pipeline. The adapter never sees unvalidated messages. If no
`surfaceAdapter` is supplied, the handler consumes and drops valid surface messages with a
no-op adapter, so hosts that do not care about A2UI do not need to render anything.

### Renderer Usage

`@agents-js/a2ui-renderer` provides a single entry point:

```ts ignore
import { renderSurface } from "@agents-js/a2ui-renderer";

const template = renderSurface(surfaceModel, {
  catalogId: "https://agents-js.bodal.dev/catalog/acp/0.1",
  onEvent: (event) => {
    // user → agent event from a rendered primitive
    surfaceAdapter.emitEvent(event);
  },
});
```

`renderSurface` returns a Lit `TemplateResult`. Hosts render it anywhere Lit templates are
supported — inside an existing `acp-*` view, inside a bespoke host layout, or standalone.
The renderer resolves component IDs against the registered catalog and binds data-model
references directly into the `acp-*` primitives.

### Gateway Event Namespace

When an A2UI-aware runtime is behind the reference gateway, the surface lifecycle is
relayed to browser clients on the existing `/agent` SSE stream. Surface messages travel as
AG-UI `CUSTOM` events:

- `type: "CUSTOM"`
- `name: "agents-js.a2ui.surface_event"`
- `value: A2uiMessage` — the validated surface-lifecycle payload.

The same namespace carries user → agent events back through
`ACPSessionEvent { type: "surface_event" }`, which the gateway round-trips onto the stream.
Consumers that only speak canonical AG-UI can ignore the event; consumers that know the
`agents-js.a2ui.*` namespace drive the renderer directly from the stream.

### Validation

Validation is always on, on both sides, and is not configurable.

- **Inbound**: every `A2uiMessage` is validated via `validateA2uiMessage` before it
  reaches the host adapter or the renderer. A failure is a protocol error and short-circuits
  the surface update.
- **Outbound**: every host-emitted event is validated before it is relayed as a
  `surface_event`. A failure is a protocol error, not a silent drop.

`validateA2uiMessage` is the single gate. Downstream code only sees a canonical A2UI
shape. There is no loose mode for A2UI — the wire contract is strict.

### Host Integrations

The repo lands the first shipped consumers of the surface lifecycle. The protocol contract
is unchanged; these are host-side wirings of the existing `CUSTOM` event channel.

#### Browser reference (`apps/web-ui`)

`apps/web-ui` is the browser reference renderer. Its `HostWSClient` observes
`surface_event` frames off the gateway WebSocket bridge, feeds each validated `A2uiMessage`
through the same per-session `MessageProcessor` pipeline used in `@agents-js/acp-host`,
maintains a `SurfaceGroupModel` of live surfaces, and calls
`renderSurface()` from `@agents-js/a2ui-renderer` to bind the resulting `SurfaceModel` onto
the `acp-*` Lit primitives. A dev-only `?a2ui=demo` query parameter exercises the render
path without a live agent.

#### pi-extension (`extras/pi-extension`)

`extras/pi-extension` is a pass-through, not a renderer. It forwards AG-UI `CUSTOM`
frames with `name = "agents-js.a2ui.surface_event"` through its existing `onProgress`
callback as `{ type: "a2ui", ... }`. Downstream consumers — Pi plugins and other pi-extension
embedders — own rendering. The extension itself does not import `@agents-js/a2ui-renderer`
and does not render a TUI surface; it is deliberately a transport hop.

#### Obsidian

Obsidian plugin integration is not part of the `agents-js` package surface.

### Known Limitations

This is a compliant implementation of the A2UI surface lifecycle. These
capabilities are outside the beta contract:

- **Opaque back-channel.** A2UI v0.9 does not standardize a user → agent event format.
  agents-js carries events through the `agents-js.a2ui.surface_event` namespace without
  claiming cross-vendor interop on the return path. Treat the back-channel as
  implementation-defined until the upstream spec lands a contract.
- **ACP catalog only.** The bundled `@agents-js/a2ui-renderer` resolves the ACP catalog
  exclusively. Surfaces that reference an unsupported catalog ID are rejected at
  validation time.
- **Single surface per session.** The current baseline assumes one active surface per ACP
  session. Multi-surface composition — including surface stacking, overlays, and
  independent lifecycles in one session — is outside the beta contract.

### Related Packages

- `packages/a2ui-types`
  — canonical `@a2ui/web_core` re-exports, surface-model helpers, and the exact pin of the
  upstream A2UI package.
- `packages/validation`
  — `validateA2uiMessage` and the surrounding validation surface.
- `@agents-js/a2ui-host/acp-host` — the `HostSurfaceAdapter` seam, `SurfaceSession`
  lifecycle, and acp-host tool-call content handler integration.
- `packages/a2ui-renderer`
  — the renderer that maps A2UI component trees onto the `acp-*` Lit primitives.
- `packages/ui-components`
  — the underlying `acp-*` primitives that the ACP catalog binds against.

### Repo Evidence

- `packages/a2ui-host/src/acp-host/` — `HostSurfaceAdapter`, `SurfaceSession`, and
  `createA2uiToolCallContentHandler`
- `packages/acp-host/` — tool-call content pipeline and `ACPSessionController`
- `packages/a2ui-renderer/` — `renderSurface` and the ACP catalog binding
- `packages/a2ui-types/` — canonical `@a2ui/web_core` re-exports
- `packages/validation/` — `validateA2uiMessage`
- `apps/internal-gateway/` — `agents-js.a2ui.surface_event` relay on `/agent`

---

## Runtime Manifests

`agents-js` treats runtime manifests as a repo-defined schema and validation surface. They are not a
transport protocol, and they do not redefine JSON-RPC, ACP, or A2A envelopes. The manifests exist
so the repo can validate runtime configuration in a small, explicit contract before a runtime is
used by the host, CLI, or browser surfaces.

### What The Contract Is For

Runtime manifests represent runtime configuration, not protocol traffic. The generic contract in
`@agents-js/validation` requires:

- `name`
- `version`

It also accepts optional fields for:

- `description`
- `runtime`
- `metadata`
- `agentCard`

The `metadata` and `agentCard` fields are freeform object pockets. That keeps the manifest useful
for runtime metadata and host-specific annotations without turning it into an open-ended protocol
frame.

### Validation Entry Point

The primary API is `validateRuntimeManifest(input, runtimeId, options?)` in
`@agents-js/validation`.

Behavior is simple:

- `runtimeId` is normalized and must be a non-empty string
- if a validator is registered for that runtime, `validateRuntimeManifest(...)` uses it
- otherwise, the input is checked against the generic runtime-manifest schema
- the validated value is returned, and registered validators may return a replacement object

The generic validator runs through the same validation-mode machinery as the rest of the package,
so manifest validation can be `strict`, `loose`, or `filter`.

### Validator Registration

`registerRuntimeValidator(runtimeId, validator)` lets the repo or a consumer install a
runtime-specific validator for a given runtime id.

That gives `agents-js` two layers of validation:

- a generic manifest shape that applies when no runtime-specific validator exists
- a runtime-specific validator that can tighten or extend the contract for a named runtime

The registry is intentionally runtime-id keyed, and the test helper
`resetRuntimeValidatorsForTest()` clears it between cases.

### Validation Modes

Manifest validation honors the repo-wide validation modes:

The generic schema uses those modes the same way the rest of `@agents-js/validation` does:

- `strict` rejects unknown fields
- `loose` preserves them
- `filter` removes them from the returned value

That matters because runtime manifests often need to carry extra runtime metadata without changing
the core schema. The mode controls whether those extras are rejected, preserved, or stripped.

### Boundary Relative To Protocols

Runtime manifests sit beside the transport protocols, not inside them.

- JSON-RPC defines the frame for ACP and A2A
- ACP defines the local runtime/session protocol
- A2A defines the HTTP/SSE gateway surface
- runtime manifests define repo-owned configuration validation for runtime selection and metadata

That separation is deliberate:

- runtime manifests are not a wire protocol
- they do not alter ACP or A2A envelope rules
- they are validated independently from transport-level schema checks
- protocol-specific behavior stays in ACP/A2A validation and host orchestration

### CLI Validation

The validation package CLI exposes runtime-manifest checking as a first-class target:

```sh
agents-validate --source runtime.json --target runtime-manifest --runtime claude
```

That path uses the same manifest validator exported by `@agents-js/validation`, so CLI checks and
library checks share the same contract.

### Repo Evidence

- `packages/validation/src/runtime.ts`
- `packages/validation/src/cli.ts`
- `packages/validation/src/modes.ts`
- `packages/validation/tests/runtime.test.ts`
- `packages/validation/tests/modes.test.ts`
- `packages/validation/README.md`
- `docs/primitives.md`

---

## Related Reading

- [Architecture](/primitives) for how the protocol layers map onto packages and interfaces
- [ACP Host Embedding](/harness-guide) for the host-owned ACP boundary
- [A2A Streaming Contract](/streaming-and-events) for the current streaming claim
- [API Reference](/api/) for the generated package surface
