# @agents-js/a2a-client

> A2A client transport, AG-UI adapter, target registry, session view-model, and discovery helpers for agents-js consumers.

## Installation

```sh
bun add @agents-js/a2a-client
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`AGUIUnsupportedOperationError`** — Thrown by {AguiToA2ATransportAdapter} when a caller invokes an A2A task-shaped method that has no AG-UI counterpart (e.g. `getTask`, `cancelTask`, push-notification config). AG-UI has no task lifec...
- **`AGUIStreamError`** — Thrown by {parseAguiSseStream} / {AGUITransport} when the server-sent event stream is malformed, emits an invalid AG-UI event, or is torn down unexpectedly.
- **`AGUITransport`** — Native AG-UI client transport. This is a **parallel** surface to {A2ATransport}, not a subtype. AG-UI has no task lifecycle, so the task-shaped methods on `A2ATransport` have no AG-UI counterpart. ...
- **`AguiToA2ATransportAdapter`** — Adapts an {AGUITransport} so it can sit behind the existing `A2AClientProvider` and session reducer without them knowing about the underlying protocol. Semantic bridging: - `sendMessageStream(param...
- **`AgentRegistryConfigError`** — Thrown when the registry config file cannot be read or parsed.
- **`AgentRegistry`** — Agent registry that resolves `-name` references to A2A endpoints. Reads agent entries from a JSON config file and fetches + caches agent cards from the resolved URLs. `kind: "acp"` entries are pars...
- **`SdkA2ATransport`** — Default A2A transport implementation backed by the A2A SDK. Handles HTTP/SSE communication with A2A agents: target resolution via agent card discovery, message sending (immediate and streaming), ta...
- **`PeerSyncError`** — Thrown when a peer's sync endpoint is unreachable, non-200, or returns an invalid payload.

### Functions

- **`escapeA2ADelegationInnerText`** — Escape a delegated agent's response so it cannot break out of the outer `<a2a-delegation-response>` markers. Rewrites any literal occurrences of the open or close tags inside `innerText` with zero-...
- **`buildA2ADelegationFramingText`** — Build the framing prompt that wraps a remote agent's response so the receiving LLM recognizes it as "the answer from ``" rather than ambient context. Without this framing, Claude tends to ignore an...
- **`extractA2AResponseText`**
- **`createA2AMentionMiddleware`**
- **`randomUuid`** — Secure-context-safe RFC 4122 v4 UUID generator. Browsers only expose `crypto.randomUUID()` in secure contexts (HTTPS origins or `localhost` / `127.0.0.1`). Serving the reference web-ui over plain H...
- **`applyJsonPatch`** — Apply an array of JSON Patch (RFC 6902) operations to a state object immutably. Returns a new state object with all operations applied. The input state is not modified. Throws descriptive errors fo...
- **`resolveSharedAgentRegistryPath`**
- **`readAgentRegistryRecords`** — Read the v2 record shape, applying v1→v2 migration in-memory. Returns an empty map when the file is absent or unparsable (fails open).
- **`serializeRecords`** — Build the on-disk JSON payload from a record map, preserving v2 shape. Exported so the sync module can write the merged state using the same serializer autoRegister uses — one source of truth for t...
- **`autoRegister`** — Idempotent auto-registration. Writes a v2 record for `options.name`, replacing any prior entry with the same name. Synthesizes provenance (`gateway_id`, `source=auto-reg`, `registered_at`, `agent_i...
- **`startRegistrySync`** — Wire auto-registration and peer-sync into a gateway startup path. Returns immediately — auto-registration is fire-and-forget. ```ts const sync = startRegistrySync({ name: "my-gateway", url: baseUrl...
- **`createSharedAgentRegistry`**
- **`groupDiscoveredTargets`** — Group/dedupe a raw list of discovered targets by `name`, picking a canonical `preferred` entry per group under the configured policy. The function is pure and opt-in — passing no `options` (or `{}`...
- **`normalizeHeaders`**
- **`normalizeAgentTargetInput`**
- **`originCardFallback`** — Returns an origin-level variant of `normalized` when the base path is non-empty. Used as a resolution fallback for the common misuse pattern where the caller passes a JSON-RPC endpoint URL (e.g. `h...
- **`summarizeCapabilities`**
- **`truncateText`**
- **`createDebugFetch`**
- **`parseAgentMentions`** — Extracts `-name` mentions from text content. Returns an array of {ParsedMention} objects describing each valid mention found. Email addresses (e.g. `user.com`) are NOT matched because the `@` must ...
- **`parseDispatchDirective`** — Parses a `@-name payload` dispatch directive from the user text. Unlike `` which are annotations that can appear anywhere, `@@` is a deterministic routing directive: the entire message is consumed ...
- **`stripMention`** — Removes a previously-parsed mention from the source text. Returns the text with the mention's `fullMatch` removed at the correct position. Trailing whitespace immediately after the mention is colla...
- **`adaptTarget`** — Orchestrates the probe → auth → transform pipeline for a given TargetAdapter. 1. Constructs the probe URL from baseUrl + adapter.probePath 2. Calls adapter.authHeader (if defined) to get an Authori...
- **`describeSessionStatus`** — Map an {A2ASessionState} to a polished, protocol-neutral {SessionStatusViewModel} suitable for rendering in UI clients (Raycast, web-ui, Obsidian plugin, terminal CLIs, etc.). Discriminator priorit...
- **`isTerminalTaskState`**
- **`collectTextParts`**
- **`extractMessageText`**
- **`extractLatestAgentMessage`**
- **`extractLatestAgentText`**
- **`createInitialSessionState`**
- **`reduceA2ASessionState`**
- **`extractAcpElicitationMetadata`**
- **`extractAcpAuthRequiredMetadata`**
- **`buildAcpElicitationResponseMetadata`**
- **`fetchPeerRecords`** — GET the peer gateway's sync endpoint and return the records it serves. Throws {PeerSyncError} on network failure, non-2xx, or malformed payload.
- **`mergeRecords`** — Pure-function merge surface — exported for white-box tests of the matrix.
- **`syncFromPeer`** — Pull-sync from a single peer. Fetches the peer's sync endpoint, drops self-originated records, merges the rest into the local registry, and writes the result to disk. Returns a {SyncSummary} descri...
- **`buildSyncPayload`** — Produce the wire payload this gateway would serve at its sync endpoint. Three filters apply, in order: 1. `source !== "sync"` — loop prevention on the send side; we never re-serve records we receiv...
- **`createSyncEndpointHandler`** — Build a `(req: Request) => Promise<Response | null>` compatible with `UniversalA2AServerOptions.additionalFetch`. The gateway wires this into its existing fetch hook so the sync endpoint lives on t...

### Interfaces

- **`AgentMentionRegistry`**
- **`A2AMentionResponseBlockOptions`**
- **`A2AMentionDispatchOptions`**
- **`A2AMentionDispatchError`**
- **`A2AMentionDispatchSuccess`**
- **`CreateA2AMentionMiddlewareOptions`**
- **`A2ADelegationFramingTemplate`** — Declarative template for the delegation framing prompt. Consumers (tests, host integrations, alternate `buildResponseBlock` implementations) should import this rather than rebuild the literal strin...
- **`AutoRegisterOptionsBase`** — Options shared by all {autoRegister} calls.
- **`AutoRegisterA2AOptions`** — Transport-a2a auto-reg options.
- **`AutoRegisterACPOptions`** — Transport-acp auto-reg options.
- **`StartRegistrySyncOptions`** — Options for {startRegistrySync}.
- **`RegistrySyncHandle`** — Handle returned by {startRegistrySync}.
- **`SharedAgentRegistry`**
- **`SharedAgentRegistryOptions`**
- **`DiscoveredTarget`** — Input shape consumed by {groupDiscoveredTargets}. Wraps a registry record with the optional probe-derived reachability + error reason. Consumers produce these from `AgentRegistry.list()` results pa...
- **`DiscoveredTargetGroup`** — Output of {groupDiscoveredTargets} — one bucket per unique agent name. The `preferred` entry is the canonical pick under the configured policy; `alternates` carries the rest of the duplicates (gate...
- **`GroupDiscoveredTargetsOptions`** — Behavior knobs for {groupDiscoveredTargets}. All flags default to `false` so the helper is a pass-through unless callers opt in.
- **`NormalizedAgentTargetInput`**
- **`AGUITransportOptions`** — Options for constructing an {AGUITransport}.
- **`AGUIRunResult`** — Result of a single AG-UI `runAgent` call.
- **`ParsedMention`** — Pure functions for parsing `-name` mentions from text content. Agent names are alphanumeric + hyphens (e.g. `knowledge-compiler`, `code-reviewer`). A mention is valid when preceded by whitespace or...
- **`ParsedDispatchDirective`**
- **`AgentTargetInput`**
- **`CapabilitySummary`**
- **`ResolvedAgentTarget`**
- **`ProbeResult`**
- **`TargetInspection`**
- **`DebugRecord`**
- **`TranscriptEntry`**
- **`ACPA2AElicitationSchema`**
- **`ACPA2AElicitation`**
- **`ACPA2AElicitationResponse`**
- **`A2AAuthRequiredState`** — Lightweight typed view of an active auth-required prompt for UI consumers. Each `authMethods[]` entry carries the protocol-level method id alongside optional human-presentable fields. `link` is the...
- **`SessionStatusViewModel`** — View-model for rendering a polished, protocol-neutral session status in downstream UIs. Produced by {describeSessionStatus}. Severity levels are stable across UI clients: `info` for the calm idle/d...
- **`SessionStatusAction`**
- **`A2ASessionState`**
- **`SendTurnOptions`**
- **`CancelTaskOptions`** — Options for {A2AClientController.cancelTask}. When `taskId` is omitted, the controller defaults to the active session's `taskId` if present, falling back to `resumableTaskId`. This matches what UI ...
- **`ResumeTurnOptions`**
- **`A2ATargetResolvedEvent`**
- **`JsonPatchOperation`** — A single JSON Patch (RFC 6902) operation.
- **`A2ASessionUpdatedEvent`**
- **`A2ATurnStartedEvent`**
- **`A2AMessageDeltaEvent`** — A partial message update. **Note on `text` vs `delta` semantics:** - `text` carries the **accumulated** message text (all content so far). - `delta` (AG-UI spec alias) carries the **incremental** c...
- **`A2AMessageCompletedEvent`**
- **`A2ATaskUpdatedEvent`**
- **`A2ATaskStatusUpdatedEvent`**
- **`A2ATaskArtifactUpdatedEvent`**
- **`A2AErrorEvent`**
- **`A2ARequestSentEvent`** — Lifecycle signals for streaming/non-streaming sends. Lifecycle events are pure diagnostics: they never participate in `transcript` / `pendingAgentText` / task-state transitions. UI consumers can re...
- **`A2AStreamOpenedEvent`**
- **`A2AStreamFirstEventEvent`** — First event has been received from the stream (or first response from non-streaming).
- **`A2AStreamLastEventEvent`** — A new event has arrived; useful for clients that want to track last-activity.
- **`A2AStreamIdleEvent`** — Stream has been silent for the configured idle threshold without reaching a terminal state. UI consumers should surface a user-facing "no stream event for N seconds" warning. Idle timer clears on e...
- **`A2AStreamClosedEvent`** — Stream closed cleanly (terminal task state reached or generator exhausted).
- **`A2AAbortSendEvent`** — Send was aborted by an `AbortSignal` before any transport request was issued. Emitted instead of `error` when {SendTurnOptions.signal} is already aborted on entry to `sendTurn`/`resumeTurn`, or whe...
- **`A2AAbortStreamEvent`** — Send/resume stream was aborted by an `AbortSignal` mid-flight. Emitted when the abort fires after the streaming connection opened but before it reaches a terminal task state. Distinguishes user-ini...
- **`A2ACancellationRequestedEvent`** — Local cancellation was requested by the caller. Useful for UI consumers that want to render a "canceling..." state before a remote-cancel result (`cancellation.succeeded` / `cancellation.failed`) l...
- **`A2ACancellationSucceededEvent`** — Remote-side `cancelTask` completed successfully. UI consumers can use this to confirm to the user that the remote agent actually accepted the cancellation, vs falling back to local-only teardown (w...
- **`A2ACancellationFailedEvent`** — Remote-side `cancelTask` rejected. The corresponding `error` event carries the underlying transport message; this event lets consumers distinguish cancellation-failure from a generic operation error.
- **`A2ARunStartedEvent`** — AG-UI spec: signals the start of an agent run (one user turn). Emitted alongside the existing agents-js `turn.started` event during the transition window. `runId` is unique per turn; `threadId` is ...
- **`A2ARunFinishedEvent`** — AG-UI spec: signals the successful completion of an agent run. Emitted alongside the existing agents-js `message.completed` event during the transition window. Shares `runId`/`threadId` with the pr...
- **`A2ARunErrorEvent`** — AG-UI spec: signals that an agent run failed. Emitted alongside the existing agents-js `error` event during the transition window. `runId`/`threadId` are populated when an in-flight turn context is...
- **`A2ADebugRecordEvent`**
- **`A2AMessageStartEvent`** — Signals the start of a new message. The `role` union is widened beyond the AG-UI spec to keep `"agent"` as an agents-js-local alias for `"assistant"` (pre-existing semantics). All spec values (`"de...
- **`A2AMessageEndEvent`**
- **`A2AStepStartedEvent`**
- **`A2AStepFinishedEvent`**
- **`A2ACustomEvent`**
- **`A2AReasoningStartEvent`**
- **`A2AReasoningMessageStartEvent`**
- **`A2AReasoningMessageContentEvent`** — Streams a full reasoning content block. Emitters should populate both `text` (agents-js legacy) and `delta` (AG-UI spec alias) with the same value during the transition window.
- **`A2AReasoningMessageEndEvent`**
- **`A2AReasoningMessageChunkEvent`** — Streams an incremental reasoning chunk. Emitters should populate both `text` (agents-js legacy) and `delta` (AG-UI spec alias) with the same value during the transition window.
- **`A2AReasoningEndEvent`**
- **`A2AReasoningEncryptedEvent`** — Encrypted reasoning payload. `data` is the agents-js legacy field carrying the encrypted value. The AG-UI spec shape uses `subtype`, `entityId`, and `encryptedValue`. When an emitter populates the ...
- **`A2AToolCallStartEvent`** — Marks the start of a tool call. Emitted once per `toolCallId` before any `tool_call.args` or `tool_call.end` event.
- **`A2AToolCallArgsEvent`** — Incremental JSON argument chunk for a tool call. Emitters should populate both `argsChunk` (agents-js legacy) and `delta` (AG-UI spec alias) with the same value during the transition window.
- **`A2AToolCallEndEvent`** — Marks the end of a tool call. Emitted once per `toolCallId` after all `tool_call.args` events and when the underlying tool call reaches a terminal state (completed or failed).
- **`A2ATransport`** — Transport interface for A2A protocol I/O. This is the **Transport** port in the Ports & Adapters architecture. The default implementation is {SdkA2ATransport} (HTTP/SSE via the A2A SDK). Implement ...
- **`AdaptTargetContext`** — Context passed to TargetAdapter hooks during card adaptation.
- **`AdaptedTarget`** — Result of a successful adapt flow.
- **`TargetAdapter`** — Adapter interface for non-standard A2A agents. Implement this to teach `adaptTarget` how to: 1. Find the agent card at a non-standard path (`probePath`) 2. Optionally authenticate the probe (`authH...
- **`AdaptTargetOptions`** — Options for adaptTarget. Allows injecting a custom fetch for testing.
- **`A2AAgentEntry`** — A registry entry describing a remote A2A agent reachable over HTTP.
- **`ACPAgentEntry`** — A registry entry describing a locally spawnable ACP harness.
- **`AgentRegistryOptions`** — Options for constructing an {AgentRegistry}.
- **`A2AClientControllerOptions`**
- **`AgentsJsRegistrySyncPayload`** — Wire-format payload served by the sync endpoint and consumed by peers. Records are typed as the wire shape — `kind="acp"` and the operator- controlled launch fields (`command`, `args`, `env`, `work...
- **`FetchPeerRecordsOptions`** — Options for {fetchPeerRecords}.
- **`SyncSummary`** — Summary returned by {syncFromPeer}. Each record surfaces in exactly one array + one action.
- **`SyncFromPeerOptions`** — Options for {syncFromPeer}.
- **`SyncEndpointHandlerOptions`** — Options for {createSyncEndpointHandler}.

### Types

- **`AgentMentionResolver`**
- **`AgentMentionMap`**
- **`AgentRegistryRecord`**
- **`AutoRegisterOptions`**
- **`StartupLogger`** — Console-shaped logger subset used by {startRegistrySync}.
- **`TargetReachability`** — Per-target health/probe status as seen by a UI client. Discovery implementations can map their own probe results to this triplet: `online` (target responded), `offline` (probe failed), `unknown` (p...
- **`FetchLike`**
- **`AgentTargetMode`**
- **`TargetInspectionStatus`**
- **`A2ASendResult`**
- **`A2AStreamEvent`** — AG-UI event types that may appear in SSE streams alongside standard A2A events.
- **`ACPA2AElicitationContentValue`**
- **`SessionStatus`**
- **`CancelTaskResult`** — Result of {A2AClientController.cancelTask}. `outcome` distinguishes: - `"canceled"` — the transport's `cancelTask` call resolved successfully. `task` carries the resulting Task (typically with stat...
- **`A2AEvent`**
- **`A2AEventListener`**
- **`RawAgentCard`** — Raw card shape returned by a non-standard agent probe endpoint. Kept as a loose record to avoid over-constraining what Agent Zero returns.
- **`AgentKind`** — Kind of agent transport — `a2a` entries are routable over HTTP A2A; `acp` entries describe a spawnable ACP harness.
- **`AgentActorType`** — Who or what is behind an agent. Governance classifier; distinct from transport `kind`.
- **`AgentRegistrySource`** — How a registry record got here on this gateway.
- **`AgentEntry`** — A single entry from the registry config file (discriminated on `kind`).
- **`SyncLogger`**
- **`SyncAction`** — Why a single record changed (or did not change) during a sync merge.

### Constants

- **`A2A_DELEGATION_RESPONSE_OPEN_TAG`** — Outer open-tag for the A2A delegation framing. Consumers (tests, host integrations, alternate `buildResponseBlock` implementations) should import this constant rather than hardcode the string.
- **`A2A_DELEGATION_RESPONSE_CLOSE_TAG`** — Outer close-tag for the A2A delegation framing. Paired with `A2A_DELEGATION_RESPONSE_OPEN_TAG`.
- **`A2A_DELEGATION_FRAMING_TEMPLATE`** — Canonical framing template used by `defaultBuildResponseBlock`. Exported so the framing-contract regression test can assert against the exact strings, and so downstream consumers that emit equivale...
- **`ACP_A2A_AUTH_REQUIRED_METADATA_KEY`**
- **`ACP_A2A_ELICITATION_METADATA_KEY`**
- **`ACP_A2A_ELICITATION_RESPONSE_METADATA_KEY`**
- **`AGENTS_JS_REGISTRY_WELL_KNOWN_PATH`** — Well-known path the peer sync endpoint is mounted at.

### Exports

- **`A2AClientController`**
- **`type A2AClientControllerOptions`**
- **`A2AClientProvider`**
- **`parseAguiSseStream`**


## Dependencies

- `@agentclientprotocol/sdk`
- `@a2a-js/sdk`
- `@agents-js/a2a`
- `@agents-js/agui-types`
- `@agents-js/validation`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
