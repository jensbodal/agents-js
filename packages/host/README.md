# @agents-js/host

> Host orchestration for the agents-js A2A gateway: ACP-backed A2A executor, AG-UI fetch handler, WebSocket bridge, and surface broadcaster.

## Installation

```sh
bun add @agents-js/host
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`HostA2AExecutor`** — Bridges A2A execution requests to an ACPSessionController. Unlike ACPtoA2AExecutor which manages raw ACP streams, this executor delegates all lifecycle management to the controller and focuses on t...

### Functions

- **`resolveHostWorkspaceFlag`**
- **`loadRegistryFromDisk`** — Load the agent registry from disk. Reads from `AGENTS_JS_REGISTRY` env var or `~/.agents-js/registry.json`. Returns an empty map on any read/parse error (this silent fallback is intentional: a miss...
- **`createGatewaySurfaceBroadcaster`**
- **`createAguiFetchHandler`** — Build a `(req: Request) => Promise<Response | null>` handler suitable for `UniversalA2AServerOptions.additionalFetch`. Returns `null` when the request is not for this handler — the caller then fall...
- **`createGatewayTestServer`** — Construct a running gateway test server bound to the given ACP command. This assembles the same three layers as the production gateway: 1. `ACPSessionController` with Node file adapters + empty per...
- **`createTranslatorState`**
- **`translateAcpEvent`** — Translate a single `ACPSessionEvent` into zero or more AG-UI events. Mutates only the caller-owned `state` (specifically, the embedded `AguiEventStream`'s open-message + dedup tracking).
- **`fetchRuntimeModels`**
- **`createEnsureSessionCoordinator`**
- **`createRuntimeSwitchCoordinator`**
- **`createWSBridge`**
- **`switchHostSessionRuntime`**
- **`createStandaloneHostController`** — Spawn a standalone `GatewayHostController` detached from any `HostSession`. Used by `HostA2AExecutor`'s Phase-2 controller factory: every distinct A2A `contextId` gets its own freshly-started contr...
- **`createHostSession`**
- **`buildRuntimeProfileConfigEnv`**
- **`getEnvRuntimeProfileName`**
- **`applyEnvRuntimeProfile`**
- **`buildHostRuntimeEnvPolicy`** — Build the {HostEnvPolicyInput} for the gateway host: baseline secrets plus the per-harness `authEnvKeys` declared on the resolved runtime. The host has the harness identity in scope here, so it own...
- **`formatAguiSseFrame`**
- **`enqueueAguiEvent`** — Validate an AG-UI event and enqueue it as an SSE frame. Invalid events are logged and dropped — the always-on validation gate is a core contract, so silently skipping a bad frame is safer than emit...
- **`runAguiSession`** — Run one AG-UI run from start to finish. Caller is responsible for enqueuing the leading `RUN_STARTED` frame and closing the sink after this promise resolves. Why the sink is injected rather than ow...

### Interfaces

- **`GatewaySurfaceBroadcaster`** — Adapter that plugs into the ACP host session and, once attached to a live broadcaster, forwards every lifecycle message to that broadcaster.
- **`GatewaySurfaceBroadcasterConfig`**
- **`AguiEndpointOptions`**
- **`GatewayTestServerOptions`**
- **`GatewayTestServerHandle`**
- **`HostA2AExecutorOptions`**
- **`TranslatorState`** — Mutable state carried across translator invocations for a single run. The translator delegates open-message tracking and tool-call dedup to the shared `createAguiEventStream` builder so this surfac...
- **`RuntimeModelInfo`** — Fetches and caches the list of available models from a runtime CLI command. Runs `<command> models` and parses the output into structured model info. Results are cached in memory so repeated calls ...
- **`RuntimeSnapshotInfo`**
- **`RuntimeSwitchState`**
- **`RuntimeSwapResult`**
- **`WSBridgeConfig`**
- **`WSBridgeHandle`**
- **`RuntimeBridgeSnapshot`**
- **`HostSessionConfig`**
- **`HostSession`**
- **`RunSessionOptions`**
- **`RunSessionResult`** — Result of running an AG-UI run session to completion.

### Types

- **`AgentRegistryMap`** — Name-keyed agent map used by the gateway's dispatch path.
- **`SurfaceBroadcastFn`** — Fan-out callback handed to the broadcaster by the WS bridge.
- **`RuntimeSwitchOrigin`**
- **`WSBridgeState`**
- **`WSServerMessage`** — Server-to-client messages
- **`WSClientMessage`** — Client-to-server messages
- **`GatewayHostController`**

### Constants

- **`__testing`**
- **`E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV`**
- **`E2E_RUNTIME_PROFILE_DATA_HOME_ENV`**
- **`E2E_RUNTIME_PROFILE_PREFIX_ENV`**
- **`E2E_RUNTIME_PROFILE_RUNTIMES_ENV`**
- **`E2E_RUNTIME_PROFILE_STATE_HOME_ENV`**
- **`CURATED_RUNTIME_IDS`**
- **`BASELINE_AGENT_SECRET_ENV_KEYS`** — Baseline secret keys forwarded to every ACP runtime, regardless of which harness is selected. These cover shared infra (`MATRIX_ACCESS_TOKEN`) and the Anthropic default (`ANTHROPIC_API_KEY`) that s...

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
