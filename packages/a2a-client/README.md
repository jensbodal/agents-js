# @agents-js/a2a-client

> A2A client transport, AG-UI adapter, target registry, session view-model, and discovery helpers for agents-js consumers.

## Installation

```sh
bun add @agents-js/a2a-client
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`A2AClientController`**
- **`A2AClientProvider`** — Event-driven A2A client provider -- the **Provider** layer for A2A communication. Orchestrates turn execution (send, stream, resume), target resolution, and event emission. Delegates all protocol I...
- **`AgentRegistry`** — Agent registry that resolves `-name` references to A2A endpoints. Reads agent entries from a JSON config file and fetches + caches agent cards from the resolved URLs. `kind: "acp"` entries are pars...
- **`AgentRegistryConfigError`** — Thrown when the registry config file cannot be read or parsed.
- **`AGUIStreamError`** — Thrown by {parseAguiSseStream} / {AGUITransport} when the server-sent event stream is malformed, emits an invalid AG-UI event, or is torn down unexpectedly.
- **`AguiToA2ATransportAdapter`** — Adapts an {AGUITransport} so it can sit behind the existing `A2AClientProvider` and session reducer without them knowing about the underlying protocol. Semantic bridging: - `sendMessageStream(param...
- **`AGUITransport`** — Native AG-UI client transport. This is a **parallel** surface to {A2ATransport}, not a subtype. AG-UI has no task lifecycle, so the task-shaped methods on `A2ATransport` have no AG-UI counterpart. ...
- **`AGUIUnsupportedOperationError`** — Thrown by {AguiToA2ATransportAdapter} when a caller invokes an A2A task-shaped method that has no AG-UI counterpart (e.g. `getTask`, `cancelTask`, push-notification config). AG-UI has no task lifec...
- **`PeerSyncError`** — Thrown when a peer's sync endpoint is unreachable, non-200, or returns an invalid payload.
- **`SdkA2ATransport`** — Default A2A transport implementation backed by the A2A SDK. Handles HTTP/SSE communication with A2A agents: target resolution via agent card discovery, message sending (immediate and streaming), ta...

### Functions

- **`adaptTarget`** — Orchestrates the probe → auth → transform pipeline for a given TargetAdapter. 1. Constructs the probe URL from baseUrl + adapter.probePath 2. Calls adapter.authHeader (if defined) to get an Authori...
- **`applyJsonPatch`** — Apply an array of JSON Patch (RFC 6902) operations to a state object immutably. Returns a new state object with all operations applied. The input state is not modified. Throws descriptive errors fo...
- **`autoRegister`** — Idempotent auto-registration. Writes a v2 record for `options.name`, replacing any prior entry with the same name. Synthesizes provenance (`gateway_id`, `source=auto-reg`, `registered_at`, `agent_i...
- **`buildA2ADelegationFramingText`** — Build the framing prompt that wraps a remote agent's response so the receiving LLM recognizes it as "the answer from ``" rather than ambient context. Without this framing, Claude tends to ignore an...
- **`buildAcpElicitationResponseMetadata`**
- **`buildSyncPayload`** — Produce the wire payload this gateway would serve at its sync endpoint. Three filters apply, in order: 1. `source !== "sync"` — loop prevention on the send side; we never re-serve records we receiv...
- **`collectTextParts`** — Recursively collect `text` from ACP-shaped content (`{ type: "text", text }` or `{ kind: "text", text }`). Used by the mention middleware to flatten ACP `ContentBlock[]` prompt content — this walks...
- **`createA2AMentionMiddleware`**
- **`createDebugFetch`**
- **`createInitialSessionState`**
- **`createSharedAgentRegistry`**
- **`createSyncEndpointHandler`** — Build a `(req: Request) => Promise<Response | null>` compatible with `UniversalA2AServerOptions.additionalFetch`. The gateway wires this into its existing fetch hook so the sync endpoint lives on t...
- **`describeSessionStatus`** — Map an {A2ASessionState} to a polished, protocol-neutral {SessionStatusViewModel} suitable for rendering in UI clients (Raycast, web-ui, Obsidian plugin, terminal CLIs, etc.). Discriminator priorit...
- **`escapeA2ADelegationInnerText`** — Escape a delegated agent's response so it cannot break out of the outer `<a2a-delegation-response>` markers. Rewrites any literal occurrences of the open or close tags inside `innerText` with zero-...
- **`extractA2AResponseText`**
- **`extractAcpAuthRequiredMetadata`**
- **`extractAcpElicitationMetadata`**
- **`extractLatestAgentMessage`**
- **`extractLatestAgentText`**
- **`extractMessageText`**
- **`fetchPeerRecords`** — GET the peer gateway's sync endpoint and return the records it serves. Throws {PeerSyncError} on network failure, non-2xx, or malformed payload.
- **`groupDiscoveredTargets`** — Group/dedupe a raw list of discovered targets by `name`, picking a canonical `preferred` entry per group under the configured policy. The function is pure and opt-in — passing no `options` (or `{}`...
- **`isRegistryRecordExpired`** — Predicate: is this record expired at the given instant? A record is expired iff `expires_at` is present AND parseable AND `parseISO(expires_at) <= now`. Records with no `expires_at` are NEVER expir...
- **`isTerminalTaskState`** — Wire-boundary predicate: is this proto {TaskState} terminal? Terminal states close the SSE stream and clear the resumable task. Callers pass the raw proto enum from `task.status.state` / `update.st...
- **`mergeRecords`** — Pure-function merge surface — exported for white-box tests of the matrix.
- **`normalizeAgentTargetInput`**
- **`normalizeHeaders`**
- **`originCardFallback`** — Returns an origin-level variant of `normalized` when the base path is non-empty. Used as a resolution fallback for the common misuse pattern where the caller passes a JSON-RPC endpoint URL (e.g. `h...
- **`parseAgentMentions`** — Extracts `-name` mentions from text content. Returns an array of {ParsedMention} objects describing each valid mention found. Email addresses (e.g. `user.com`) are NOT matched because the `@` must ...
- **`parseDispatchDirective`** — Parses a `@-name payload` dispatch directive from the user text. Unlike `` which are annotations that can appear anywhere, `@@` is a deterministic routing directive: the entire message is consumed ...
- **`randomUuid`** — Secure-context-safe RFC 4122 v4 UUID generator. Browsers only expose `crypto.randomUUID()` in secure contexts (HTTPS origins or `localhost` / `127.0.0.1`). Serving the reference web-ui over plain H...
- **`readAgentRegistryRecords`** — Read the v2 record shape, applying v1→v2 migration in-memory. Returns an empty list when the file is absent or unparsable (fails open). Receiver-side TTL is applied via `expiryPolicy` (AJS-97). Def...
- **`reduceA2ASessionState`**
- **`resolveSharedAgentRegistryPath`**
- **`runFederationTransportConformanceTests`** — Federation transport conformance suite. v1 surface only — test bodies are `test.todo` and become real assertions in v2 when an actual transport implementation lands (likely the HTTP A2A RemoteHarne...
- **`serializeRecords`** — Build the on-disk JSON payload from a record map, preserving v2 shape. Exported so the sync module can write the merged state using the same serializer autoRegister uses — one source of truth for t...
- **`splitAguiSseFrames`** — Pure SSE frame-boundary splitter. Given an accumulated decoded text `buffer`, return every complete frame (the bytes before each blank-line separator) plus the unterminated `rest` to carry into the...
- **`startAutoRegisterHeartbeat`** — Start a self-scheduling heartbeat loop that re-publishes the local `(name, url)` record at `intervalMs`. Returns immediately — the first registration runs fire-and-forget on the next microtask. The...
- **`startRegistrySync`** — Wire auto-registration and peer-sync into a gateway startup path. Returns immediately — auto-registration is fire-and-forget. ```ts const sync = startRegistrySync({ name: "my-gateway", url: baseUrl...
- **`stripMention`** — Removes a previously-parsed mention from the source text. Returns the text with the mention's `fullMatch` removed at the correct position. Trailing whitespace immediately after the mention is colla...
- **`summarizeCapabilities`**
- **`syncFromPeer`** — Pull-sync from a single peer. Fetches the peer's sync endpoint, drops self-originated records, merges the rest into the local registry, and writes the result to disk. Returns a {SyncSummary} descri...
- **`taskStateToVocabulary`** — Translate the proto {TaskState} enum into the protocol-neutral hyphenated vocabulary that {A2ASessionState.taskState} and the session view-model speak (`"input-required"`, `"completed"`, ...). This...
- **`truncateText`**

### Interfaces

- **`A2AAbortSendEvent`** — Send was aborted by an `AbortSignal` before any transport request was issued. Emitted instead of `error` when {SendTurnOptions.signal} is already aborted on entry to `sendTurn`/`resumeTurn`, or whe...
- **`A2AAbortStreamEvent`** — Send/resume stream was aborted by an `AbortSignal` mid-flight. Emitted when the abort fires after the streaming connection opened but before it reaches a terminal task state. Distinguishes user-ini...
- **`A2AAgentEntry`** — A registry entry describing a remote A2A agent reachable over HTTP. `A2AAgentEntry` is also the v1 dispatch primitive for parent→child gateway federation when a `HarnessCapabilityEntry` carries `so...
- **`A2AAuthRequiredState`** — Lightweight typed view of an active auth-required prompt for UI consumers. Each `authMethods[]` entry carries the protocol-level method id alongside optional human-presentable fields. `link` is the...
- **`A2AAvailableCommandsUpdatedEvent`** — The set of slash-commands currently available from the harness. Replaces state wholesale on receipt.
- **`A2ACancellationFailedEvent`** — Remote-side `cancelTask` rejected. The corresponding `error` event carries the underlying transport message; this event lets consumers distinguish cancellation-failure from a generic operation error.
- **`A2ACancellationRequestedEvent`** — Local cancellation was requested by the caller. Useful for UI consumers that want to render a "canceling..." state before a remote-cancel result (`cancellation.succeeded` / `cancellation.failed`) l...
- **`A2ACancellationSucceededEvent`** — Remote-side `cancelTask` completed successfully. UI consumers can use this to confirm to the user that the remote agent actually accepted the cancellation, vs falling back to local-only teardown (w...
- **`A2AClientControllerOptions`**
- **`A2ACustomEvent`**
- **`A2ADebugRecordEvent`**
- **`A2ADelegationFramingTemplate`** — Declarative template for the delegation framing prompt. Consumers (tests, host integrations, alternate `buildResponseBlock` implementations) should import this rather than rebuild the literal strin...
- **`A2AErrorEvent`**
- **`A2AMentionDispatchError`**
- **`A2AMentionDispatchOptions`**
- **`A2AMentionDispatchSuccess`**
- **`A2AMentionResponseBlockOptions`**
- **`A2AMessageCompletedEvent`**
- **`A2AMessageDeltaEvent`** — A partial message update. **Note on `text` vs `delta` semantics:** - `text` carries the **accumulated** message text (all content so far). - `delta` (AG-UI spec alias) carries the **incremental** c...
- **`A2AMessageEndEvent`**
- **`A2AMessageStartEvent`** — Signals the start of a new message. The `role` union is widened beyond the AG-UI spec to keep `"agent"` as an agents-js-local alias for `"assistant"` (pre-existing semantics). All spec values (`"de...
- **`A2AModeChangedEvent`** — Mode transition reported by the harness (e.g. plan→execute, model swap). ACP `current_mode_update` carries only the new `modeId`; the available-modes list lives in session metadata.
- **`A2APlanUpdatedEvent`** — The agent's structured todo-list. ACP `plan` notifications always carry the FULL set of entries; receivers replace state wholesale.
- **`A2AReasoningEncryptedEvent`** — Encrypted reasoning payload. `data` is the agents-js legacy field carrying the encrypted value. The AG-UI spec shape uses `subtype`, `entityId`, and `encryptedValue`. When an emitter populates the ...
- **`A2AReasoningEndEvent`**
- **`A2AReasoningMessageChunkEvent`** — Streams an incremental reasoning chunk. Emitters should populate both `text` (agents-js legacy) and `delta` (AG-UI spec alias) with the same value during the transition window.
- **`A2AReasoningMessageContentEvent`** — Streams a full reasoning content block. Emitters should populate both `text` (agents-js legacy) and `delta` (AG-UI spec alias) with the same value during the transition window.
- **`A2AReasoningMessageEndEvent`**
- **`A2AReasoningMessageStartEvent`**
- **`A2AReasoningStartEvent`**
- **`A2ARequestSentEvent`** — Lifecycle signals for streaming/non-streaming sends. Lifecycle events are pure diagnostics: they never participate in `transcript` / `pendingAgentText` / task-state transitions. UI consumers can re...
- **`A2ARunErrorEvent`** — AG-UI spec: signals that an agent run failed. Emitted alongside the existing agents-js `error` event during the transition window. `runId`/`threadId` are populated when an in-flight turn context is...
- **`A2ARunFinishedEvent`** — AG-UI spec: signals the successful completion of an agent run. Emitted alongside the existing agents-js `message.completed` event during the transition window. Shares `runId`/`threadId` with the pr...
- **`A2ARunStartedEvent`** — AG-UI spec: signals the start of an agent run (one user turn). Emitted alongside the existing agents-js `turn.started` event during the transition window. `runId` is unique per turn; `threadId` is ...
- **`A2ASessionInfoUpdatedEvent`** — Session-level metadata mutation from ACP `session_info_update`. Both fields use three-state semantics: omitted (`undefined`) → no change, `null` → explicit clear, string → replacement. Receivers me...
- **`A2ASessionState`**
- **`A2ASessionUpdatedEvent`**
- **`A2AStepFinishedEvent`**
- **`A2AStepStartedEvent`**
- **`A2AStreamClosedEvent`** — Stream closed cleanly (terminal task state reached or generator exhausted).
- **`A2AStreamFirstEventEvent`** — First event has been received from the stream (or first response from non-streaming).
- **`A2AStreamIdleEvent`** — Stream has been silent for the configured idle threshold without reaching a terminal state. UI consumers should surface a user-facing "no stream event for N seconds" warning. Idle timer clears on e...
- **`A2AStreamLastEventEvent`** — A new event has arrived; useful for clients that want to track last-activity.
- **`A2AStreamOpenedEvent`**
- **`A2ATargetResolvedEvent`**
- **`A2ATaskArtifactUpdatedEvent`**
- **`A2ATaskStatusUpdatedEvent`**
- **`A2ATaskUpdatedEvent`**
- **`A2AToolCallArgsEvent`** — Incremental JSON argument chunk for a tool call. Emitters should populate both `argsChunk` (agents-js legacy) and `delta` (AG-UI spec alias) with the same value during the transition window.
- **`A2AToolCallEndEvent`** — Marks the end of a tool call. Emitted once per `toolCallId` after all `tool_call.args` events and when the underlying tool call reaches a terminal state (completed or failed). Carries the final ACP...
- **`A2AToolCallProgressEvent`** — Non-terminal mid-call update. ACP `tool_call_update` notifications carry status transitions (`pending` → `in_progress`) and/or payload mutations (content/locations/raw I/O) without ending the call....
- **`A2AToolCallStartEvent`** — Marks the start of a tool call. Emitted once per `toolCallId` before any `tool_call.args` or `tool_call.end` event. Carries the full ACP `ToolCall` payload forwarded from the wire so receivers can ...
- **`A2ATransport`** — Transport interface for A2A protocol I/O. This is the **Transport** port in the Ports & Adapters architecture. The default implementation is {SdkA2ATransport} (HTTP/SSE via the A2A SDK). Implement ...
- **`A2ATurnStartedEvent`**
- **`A2AUsageUpdatedEvent`** — Token-budget telemetry. `size` = total context window tokens, `used` = consumed so far, `cost` = structured `Cost` from the SDK (`{ amount, currency }`) preserved verbatim — `null` is a valid harne...
- **`ACPA2AElicitation`**
- **`ACPA2AElicitationResponse`**
- **`ACPA2AElicitationSchema`**
- **`ACPAgentEntry`** — A registry entry describing a locally spawnable ACP harness.
- **`ActiveToolCall`** — Snapshot of a single in-flight or recently-completed tool call. Mirrored on session state so the TUI can render an inline status row that swaps in place as the call progresses. Optional fields mirr...
- **`AdaptedTarget`** — Result of a successful adapt flow.
- **`AdaptTargetContext`** — Context passed to TargetAdapter hooks during card adaptation.
- **`AdaptTargetOptions`** — Options for adaptTarget. Allows injecting a custom fetch for testing.
- **`AgentMentionRegistry`**
- **`AgentRegistryOptions`** — Options for constructing an {AgentRegistry}.
- **`AgentRegistryRecord`** — Full v2 on-disk record shape.
- **`AgentsJsRegistrySyncPayload`** — Wire-format payload served by the sync endpoint and consumed by peers. Records are typed as the wire shape — `kind="acp"` and the operator- controlled launch fields (`command`, `args`, `env`, `work...
- **`AgentTargetInput`**
- **`AGUIRunResult`** — Result of a single AG-UI `runAgent` call.
- **`AGUITransportOptions`** — Options for constructing an {AGUITransport}.
- **`AutoRegisterA2AOptions`** — Transport-a2a auto-reg options.
- **`AutoRegisterACPOptions`** — Transport-acp auto-reg options.
- **`AutoRegisterHeartbeatHandle`** — Handle returned by {startAutoRegisterHeartbeat}.
- **`AutoRegisterOptionsBase`** — Options shared by all {autoRegister} calls.
- **`CancelTaskOptions`** — Options for {A2AClientController.cancelTask}. When `taskId` is omitted, the controller defaults to the active session's `taskId` if present, falling back to `resumableTaskId`. This matches what UI ...
- **`CapabilitySummary`**
- **`CreateA2AMentionMiddlewareOptions`**
- **`DebugRecord`**
- **`DiscoveredTarget`** — Input shape consumed by {groupDiscoveredTargets}. Wraps a registry record with the optional probe-derived reachability + error reason. Consumers produce these from `AgentRegistry.list()` results pa...
- **`DiscoveredTargetGroup`** — Output of {groupDiscoveredTargets} — one bucket per unique agent name. The `preferred` entry is the canonical pick under the configured policy; `alternates` carries the rest of the duplicates (gate...
- **`FederationConformanceOptions`** — Options to construct the conformance harness against a candidate federation transport implementation. Mirrors the `runProviderConformanceTests` signature shape from `-js/memory/testing`.
- **`FederationTransport`** — Contract any federation transport must satisfy to participate in parent→child gateway dispatch under the v1 federation contract (see `docs/federation/v1-contract.md`). Mirrors the `runProviderConfo...
- **`FetchPeerRecordsOptions`** — Options for {fetchPeerRecords}.
- **`GroupDiscoveredTargetsOptions`** — Behavior knobs for {groupDiscoveredTargets}. All flags default to `false` so the helper is a pass-through unless callers opt in.
- **`JsonPatchOperation`** — A single JSON Patch (RFC 6902) operation.
- **`NormalizedAgentTargetInput`**
- **`ParsedDispatchDirective`**
- **`ParsedMention`** — Pure functions for parsing `-name` mentions from text content. Agent names are alphanumeric + hyphens (e.g. `knowledge-compiler`, `code-reviewer`). A mention is valid when preceded by whitespace or...
- **`ProbeResult`**
- **`RegistryExpiryPolicy`** — TTL policy options for {readAgentRegistryRecords}.
- **`RegistrySyncHandle`** — Handle returned by {startRegistrySync}.
- **`ResolvedAgentTarget`**
- **`ResumeTurnOptions`**
- **`SendTurnOptions`**
- **`SharedAgentRegistry`**
- **`SharedAgentRegistryOptions`**
- **`StartAutoRegisterHeartbeatOptions`** — Options for {startAutoRegisterHeartbeat}.
- **`StartRegistrySyncOptions`** — Options for {startRegistrySync}.
- **`SyncEndpointHandlerOptions`** — Options for {createSyncEndpointHandler}.
- **`SyncFromPeerOptions`** — Options for {syncFromPeer}.
- **`SyncLogger`** — Logger shape — compatible with `console` and the gateway's A2ALogger subset we use.
- **`SyncSummary`** — Summary returned by {syncFromPeer}. Each record surfaces in exactly one array + one action.
- **`TargetAdapter`** — Adapter interface for non-standard A2A agents. Implement this to teach `adaptTarget` how to: 1. Find the agent card at a non-standard path (`probePath`) 2. Optionally authenticate the probe (`authH...
- **`TargetInspection`**
- **`TranscriptEntry`**

### Types

- **`A2AEvent`**
- **`A2AEventListener`**
- **`A2ASendResult`**
- **`A2AStreamElement`** — The full element type yielded by transport stream generators.
- **`A2AStreamEvent`** — AG-UI event types that may appear in SSE streams alongside standard A2A events.
- **`A2AStreamPayload`** — Unwrapped A2A stream payload — the `{ $case, value }` envelope the SDK's `StreamResponse.payload` carries, minus the `undefined` arm. The transport peels the `StreamResponse` wrapper at the wire ed...
- **`ACPA2AElicitationContentValue`**
- **`AgentActorType`** — Who or what is behind an agent. Governance classifier; distinct from transport `kind`.
- **`AgentEntry`** — A single entry from the registry config file (discriminated on `kind`).
- **`AgentKind`** — Kind of agent transport — `a2a` entries are routable over HTTP A2A; `acp` entries describe a spawnable ACP harness.
- **`AgentMentionMap`**
- **`AgentMentionResolver`**
- **`AgentRegistrySource`** — How a registry record got here on this gateway.
- **`AgentTargetMode`**
- **`AutoRegisterOptions`**
- **`CancelTaskResult`** — Result of {A2AClientController.cancelTask}. `outcome` distinguishes: - `"canceled"` — the transport's `cancelTask` call resolved successfully. `task` carries the resulting Task (typically with stat...
- **`FetchLike`**
- **`HeartbeatLogger`** — Console-shaped logger subset used by the heartbeat loop.
- **`RawAgentCard`** — Raw card shape returned by a non-standard agent probe endpoint. Kept as a loose record to avoid over-constraining what Agent Zero returns.
- **`RegistryExpiryMode`** — Receiver-side TTL policy applied to {readAgentRegistryRecords}. - `"include-expired"` — return every record verbatim. Used by writers that do `read → mutate → write` round-trips (autoRegister, sync...
- **`RegistryReadLogger`** — Console-shaped logger subset used by the read/expiry helpers.
- **`SessionStatus`**
- **`SessionStatusAction`** — Re-export for convenience — consumers can override action labels.
- **`SessionStatusViewModel`** — Re-export for convenience — consumers can override action labels.
- **`StartupLogger`** — Console-shaped logger subset used by {startRegistrySync}.
- **`SyncAction`** — Why a single record changed (or did not change) during a sync merge.
- **`TargetInspectionStatus`**
- **`TargetReachability`** — Per-target health/probe status as seen by a UI client. Discovery implementations can map their own probe results to this triplet: `online` (target responded), `offline` (probe failed), `unknown` (p...
- **`UrlProvider`** — URL resolver evaluated at every heartbeat tick. Implementations may return a static string (closure-captured at boot) or recompute the advertised host on each call. Both sync and async returns are ...

### Constants

- **`A2A_DELEGATION_FRAMING_TEMPLATE`** — Canonical framing template used by `defaultBuildResponseBlock`. Exported so the framing-contract regression test can assert against the exact strings, and so downstream consumers that emit equivale...
- **`A2A_DELEGATION_RESPONSE_CLOSE_TAG`** — Outer close-tag for the A2A delegation framing. Paired with `A2A_DELEGATION_RESPONSE_OPEN_TAG`.
- **`A2A_DELEGATION_RESPONSE_OPEN_TAG`** — Outer open-tag for the A2A delegation framing. Consumers (tests, host integrations, alternate `buildResponseBlock` implementations) should import this constant rather than hardcode the string.
- **`ACP_A2A_AUTH_REQUIRED_METADATA_KEY`**
- **`ACP_A2A_ELICITATION_METADATA_KEY`**
- **`ACP_A2A_ELICITATION_RESPONSE_METADATA_KEY`**
- **`AGENTS_JS_REGISTRY_WELL_KNOWN_PATH`** — Well-known path the peer sync endpoint is mounted at.
- **`DEFAULT_HEARTBEAT_INITIAL_BACKOFF_MS`** — Initial backoff after a failed `autoRegister` call.
- **`DEFAULT_HEARTBEAT_INTERVAL_MS`** — Default heartbeat cadence — 60 seconds, matches the AJS-87 spec.
- **`DEFAULT_HEARTBEAT_MAX_BACKOFF_MS`** — Backoff cap — never wait longer than this between retries.
- **`DEFAULT_STREAMING_LONG_WARN_MS`** — Default threshold (ms) before a long-running streaming delegation emits a `mention-dispatch-streaming-long-running` audit warning. Configurable via the `streamingLongWarnMs` option or the `AJS_STRE...

### Exports

- **`parseAguiSseStream`**
- **`type A2AClientControllerOptions`**


## Dependencies

- `@agentclientprotocol/sdk`
- `@a2a-js/sdk`
- `@agents-js/a2a`
- `@agents-js/agui-types`
- `@agents-js/validation`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
