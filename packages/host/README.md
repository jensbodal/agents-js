# @agents-js/host

> Host orchestration for the agents-js A2A gateway: ACP-backed A2A executor, AG-UI fetch handler, WebSocket bridge, and surface broadcaster.

## Installation

```sh
bun add @agents-js/host
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`AguiRunBusyError`** — Thrown by {AguiRunCoordinator.acquire} when a run is already active. Endpoint code maps this to HTTP 409 (Conflict) before opening the SSE stream.
- **`AguiRunCoordinator`** — Single-active-run coordinator for the shared primary controller. Concurrency model: AG-UI run-session work runs in the JavaScript event loop (no shared-memory concurrency to worry about), so the "i...
- **`HostA2AExecutor`** — Bridges A2A execution requests to an ACPSessionController. Unlike ACPtoA2AExecutor which manages raw ACP streams, this executor delegates all lifecycle management to the controller and focuses on t...

### Functions

- **`applyEnvRuntimeProfile`**
- **`buildGatewayBusEvent`** — Construct a `GatewayBusEvent` envelope with the standard `id` + `ts` fields populated. Publishers should use this rather than building envelopes inline so that the id generation + timestamp shape s...
- **`buildHostRuntimeEnvPolicy`** — Build the {HostEnvPolicyInput} for the gateway host. With no baseline keys, the policy is exactly the runtime's declared `authEnvKeys` (or empty when the runtime declares none). The host has the ha...
- **`buildRuntimeProfileConfigEnv`**
- **`createAguiFetchHandler`** — Build a `(req: Request) => Promise<Response | null>` handler suitable for `UniversalA2AServerOptions.additionalFetch`. Returns `null` when the request is not for this handler — the caller then fall...
- **`createBusPublishHandler`** — Build a `POST /admin/publish` handler that injects events onto the bus from operator tooling. Returns `null` for non-matching paths. Body shape: ```json { "type": "gateway.matrix.event-received", "...
- **`createBusSubscribeHandler`** — Build a `GET /events` SSE handler that streams every bus event to subscribed clients. Returns `null` for non-matching paths so the caller can fall through to the next handler.
- **`createEnsureSessionCoordinator`**
- **`createGatewayBus`** — Create a new in-process gateway bus. Each call returns an independent bus instance — typical gateway deployments instantiate exactly one and pass the handle to publishers and transport adapters.
- **`createGatewaySurfaceBroadcaster`**
- **`createGatewayTestServer`** — Construct a running gateway test server bound to the given ACP command. This assembles the same three layers as the production gateway: 1. `ACPSessionController` with Node file adapters + empty per...
- **`createHostSession`**
- **`createRuntimeSwitchCoordinator`**
- **`createStandaloneHostController`** — Spawn a standalone `GatewayHostController` detached from any `HostSession`. Used by `HostA2AExecutor`'s Phase-2 controller factory: every distinct A2A `contextId` gets its own freshly-started contr...
- **`createTranslatorState`**
- **`createWSBridge`**
- **`enqueueAguiEvent`** — Validate an AG-UI event and enqueue it as an SSE frame. Invalid events are logged and dropped — the always-on validation gate is a core contract, so silently skipping a bad frame is safer than emit...
- **`fetchRuntimeModels`**
- **`formatAguiSseFrame`**
- **`getEnvRuntimeProfileName`**
- **`loadRegistryFromDisk`** — Load the agent registry from disk. Reads from `AGENTS_JS_REGISTRY` env var or `~/.agents-js/registry.json`. Returns an empty map on any read/parse error (this silent fallback is intentional: a miss...
- **`resolveHostWorkspaceFlag`**
- **`runAguiSession`** — Run one AG-UI run from start to finish. Caller is responsible for enqueuing the leading `RUN_STARTED` frame and closing the sink after this promise resolves. Why the sink is injected rather than ow...
- **`switchHostSessionRuntime`**
- **`translateAcpEvent`** — Translate a single `ACPSessionEvent` into zero or more AG-UI events. Mutates only the caller-owned `state` (specifically, the embedded `AguiEventStream`'s open-message + dedup tracking).
- **`wrapAuditEmitterAsBusPublisher`** — Wrap an existing {AuditEmitter} so every recorded event is also published on the gateway bus. The wrapped emitter has the same shape as the underlying one — callers swap it in at construction and n...

### Interfaces

- **`AguiEndpointOptions`**
- **`AguiRunLease`** — Lease handle returned by {AguiRunCoordinator.acquire}. `release()` is idempotent so callers can wire it into both the happy-path `finally` and a separate abort-cancellation handler without worrying...
- **`BusEndpointOptions`** — Common construction options.
- **`CreateBusPublishHandlerOptions`** — Admin publish handler options.
- **`CreateBusSubscribeHandlerOptions`** — SSE subscribe handler options.
- **`CreateGatewayBusOptions`** — Optional construction-time hooks.
- **`GatewayBus`** — Public surface of the bus primitive.
- **`GatewayBusEvent`** — Typed envelope for every gateway bus event.
- **`GatewaySurfaceBroadcaster`** — Adapter that plugs into the ACP host session and, once attached to a live broadcaster, forwards every lifecycle message to that broadcaster.
- **`GatewaySurfaceBroadcasterConfig`**
- **`GatewayTestServerHandle`**
- **`GatewayTestServerOptions`**
- **`HostA2AExecutorOptions`**
- **`HostSession`**
- **`HostSessionConfig`**
- **`IdentityPrincipal`** — Identity principal slot. Placeholder until the agents-js/identity phase-1 types land per DOT-392 — at that point this alias is replaced with the imported type. Kept loose (open record) so the event...
- **`RunSessionOptions`**
- **`RunSessionResult`** — Result of running an AG-UI run session to completion.
- **`RuntimeBridgeSnapshot`**
- **`RuntimeModelInfo`** — Fetches and caches the list of available models from a runtime CLI command. Runs `<command> models` and parses the output into structured model info. Results are cached in memory so repeated calls ...
- **`RuntimeSnapshotInfo`**
- **`RuntimeSwapResult`**
- **`RuntimeSwitchState`**
- **`TranslatorState`** — Mutable state carried across translator invocations for a single run. The translator delegates open-message tracking and tool-call dedup to the shared `createAguiEventStream` builder so this surfac...
- **`WrapAuditEmitterAsBusPublisherOptions`** — Options for the audit-emitter wrapper publisher.
- **`WSBridgeConfig`**
- **`WSBridgeHandle`**

### Types

- **`AgentRegistryMap`** — Name-keyed agent map used by the gateway's dispatch path.
- **`AuditEmitter`**
- **`AuditEvent`**
- **`AuditEventInput`**
- **`AuditLogger`**
- **`CorrelationId`**
- **`GatewayBusSubscriber`** — Subscriber callback shape. Receives every published event.
- **`GatewayBusUnsubscribe`** — Unsubscribe handle returned from `subscribe`.
- **`GatewayHostController`**
- **`RuntimeSwitchOrigin`**
- **`SurfaceBroadcastFn`** — Fan-out callback handed to the broadcaster by the WS bridge.
- **`WSBridgeState`**
- **`WSClientMessage`** — Client-to-server messages
- **`WSServerMessage`** — Server-to-client messages

### Constants

- **`__testing`**
- **`_AUDIT_EVENT_NO_SENSITIVE_PAYLOAD`**
- **`BASELINE_AGENT_SECRET_ENV_KEYS`** — Baseline secret keys forwarded to every ACP runtime regardless of harness. **Empty by design.** Earlier revisions forwarded `ANTHROPIC_API_KEY` and `MATRIX_ACCESS_TOKEN` to every runtime as a conve...
- **`createAuditEmitter`**
- **`CURATED_RUNTIME_IDS`**
- **`E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV`**
- **`E2E_RUNTIME_PROFILE_DATA_HOME_ENV`**
- **`E2E_RUNTIME_PROFILE_PREFIX_ENV`**
- **`E2E_RUNTIME_PROFILE_RUNTIMES_ENV`**
- **`E2E_RUNTIME_PROFILE_STATE_HOME_ENV`**
- **`newCorrelationId`**

### Exports

- **`type AgentRegistryMap`**
- **`type AguiEndpointOptions`**
- **`type HostA2AExecutorOptions`**
- **`type RuntimeModelInfo`**


## Dependencies

- `@a2a-js/sdk`
- `@agentclientprotocol/sdk`
- `@agents-js/a2a`
- `@agents-js/a2a-client`
- `@agents-js/a2ui-host`
- `@agents-js/a2ui-types`
- `@agents-js/acp`
- `@agents-js/acp-host`
- `@agents-js/agui-types`
- `@agents-js/gateway-runtime`
- `@agents-js/policy`
- `@agents-js/validation`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
