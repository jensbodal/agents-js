# @agents-js/gateway-runtime

> Gateway runtime config, env parsing, runtime registry/detection, install descriptors, and sub-session spawn helpers.

## Installation

```sh
bun add @agents-js/gateway-runtime
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`SpawnSubSessionTimeoutError`** — Sentinel error used to disambiguate timeout vs ACP-layer error in the catch block. Exposed for tests that want to assert on it.

### Functions

- **`listGatewayRuntimeIds`**
- **`getGatewayRuntimeDefinition`**
- **`resolveGatewayRuntimeProfile`** — Materialize a {GatewayRuntimeProfile} via the internal profile resolver. The narrower {GatewayRuntimeId} is preserved on the returned {ResolvedGatewayRuntimeProfile}.
- **`applyGatewayRuntimeProfile`**
- **`resolveRuntimeArgs`** — Resolve the runtime argv for a curated definition, honoring env-based overrides.
- **`resolveGatewayRuntime`**
- **`resolveGatewayRuntimeSelection`**
- **`detectInstalledGatewayRuntimes`**
- **`createAcpHarness`** — Factory for building a well-formed {GatewayRuntimeDefinition}. The curated ACP harnesses are constructed via this factory so the per-harness duplication (binary name + install metadata + auth env k...
- **`mergeRuntimeEnvOverrides`**
- **`applyRuntimeEnvOverrides`** — Apply merged overrides back into `process.env` so downstream helpers that read `process.env` directly (e.g. `resolveRuntimeArgs`) observe the merged values. Returns a restore function that reverts ...
- **`getCliVersion`** — Helper for CLI bin scripts to read their package's version without triplicating string literals that drift from the actual published version. Usage from a bin script (one level deep, e.g. `packages...
- **`runCommand`**
- **`resolveExistingCommandPath`**
- **`spawnSubSession`** — Spawn a bounded-mode subagent session, run the subtask, return the terminal summary. See module-level docstring for v1 scope. Intentional invariant: cleanup runs on every path. The spawned child pr...
- **`generateSpawnCorrelationId`** — Generate a stable-looking session id for callers that spawn multiple children and want local ordering even when the gateway's own session_id isn't yet assigned (e.g. when a harness_unavailable shor...
- **`resolveAndApplyGatewayRuntime`** — Apply env overrides, resolve a runtime selection, optionally apply a configured runtime profile, and restore env. Returns the (optionally profile-merged) `ResolvedGatewayRuntime`. Errors thrown by ...
- **`parseAgentsJsConfig`**
- **`getAgentsJsConfigPaths`**
- **`mergeAgentsJsConfig`**
- **`loadAgentsJsConfig`**
- **`writeAgentsJsConfig`**
- **`parseCustomArgsJson`**
- **`createRuntimeSelectionFromArgs`**
- **`getConfiguredProfile`** — Wraps the internal profile lookup in the gateway-runtime config-paths shape so existing callers do not have to unpack `loaded.configPaths.{user,project}ConfigPath` themselves. The returned profile ...

### Interfaces

- **`GatewayRuntimeInstall`**
- **`GatewayRuntimeResolveArgsInput`**
- **`GatewayRuntimeDefinition`**
- **`ResolvedGatewayRuntimeACPOptions`** — Host-flavored {ACPProcessOptions} used for wiring resolved gateway runtimes into `-js/acp-host`'s `createHostACPProcess`. Mirrors the `HostACPProcessOptions` interface exported from `-js/acp-host` ...
- **`ResolvedGatewayRuntime`**
- **`RuntimeCommandResolver`**
- **`RuntimeResolutionOptions`**
- **`GatewayRuntimeProfile`** — Gateway-runtime-flavored {RuntimeProfile}: identical shape, but the `runtime` field is narrowed to {GatewayRuntimeId} so the curated runtime registry is the source of truth for legal harness ids in...
- **`ResolvedGatewayRuntimeProfile`** — Gateway-runtime-flavored {ResolvedRuntimeProfile}, narrowed so that the `definition.runtime` field carries {GatewayRuntimeId}.
- **`CustomGatewayRuntimeSelection`**
- **`CuratedGatewayRuntimeSelection`**
- **`CreateAcpHarnessInput`** — Input shape for {createAcpHarness}. Collocates the fields that a curated ACP harness needs to declare in one call site — binary name, npm package metadata, install hint, optional auth env keys, run...
- **`AcpAgentEntryInput`** — Structural shape required by `resolveAcpAgentEntryToRuntime`. Defined locally (rather than imported from `-js/a2a-client/node`) to avoid introducing a new workspace dependency from `gateway-runtime...
- **`RuntimeEnvOverrides`** — runtime-env-overrides.ts — Apply CLI-flag overrides onto a process env bag. The gateway runtime helpers (`resolveRuntimeArgs`, `internal-gateway` config loader, etc.) read AJS_* environment variabl...
- **`RunCommandOptions`** — Canonical `runCommand` helper used by every gateway-runtime adjacent package (`reporting`, `extras`, future call sites). Wraps `Bun.spawn` with composable timeout + abort + stdin support and a unif...
- **`RunCommandResult`**
- **`SpawnSubSessionHints`** — Routing hints. All fields optional. `harness` is explicit opt-in to a specific execution boundary; unset falls back to the default. `worktree_isolation` / `model` are accepted in the shape for forw...
- **`SpawnSubSessionParams`** — Input to {spawnSubSession}. `parent_session_id` is carried so downstream trace / audit surfaces can attribute the child to its spawning session; this layer does not enforce depth limits on it.
- **`SpawnSubSessionResult`** — Result of a bounded-mode {spawnSubSession} call. `session_id` is the ACP session id of the spawned child (empty string when the call short-circuited before session creation, e.g. harness_unavailabl...
- **`SpawnSubSessionOptions`** — Dependency injection seams. All optional; defaults wire production behavior. Tests that don't supply these get real filesystem + real subprocess spawn.
- **`ResolveAndApplyGatewayRuntimeOptions`**
- **`AgentsJsServeConfig`**
- **`AgentsJsConfig`**
- **`ConfigPathOptions`**
- **`AgentsJsConfigPaths`**
- **`LoadedAgentsJsConfig`**
- **`RuntimeSelectionArgs`**
- **`ProfileLookupContext`**

### Types

- **`GatewayRuntimeProfileRoots`** — Gateway-runtime alias for internal runtime profile roots. The shape is preserved so existing downstream imports keep compiling without churn.
- **`GatewayRuntimeSelection`**
- **`GatewayRuntimeId`**
- **`SpawnSubSessionStatus`** — Terminal status of a {spawnSubSession} call. - `completed` — subagent returned an `end_turn` stopReason within the timeout. - `errored` — subagent returned a non-`end_turn` stopReason, or the ACP h...
- **`SpawnACPAgentFn`** — Abstraction over `spawnACPAgent` for test injection. Shape matches the imported function; tests substitute a fake that returns a controlled `Stream` / `kill` handle.
- **`ResolveGatewayRuntimeFn`** — Runtime resolver shape. Factored out so tests can inject a resolver that returns canned `ResolvedGatewayRuntime` values without touching the filesystem.
- **`EnvSource`**
- **`HarnessSelectionPolicy`**

### Constants

- **`validateGatewayRuntimeProfileName`** — Re-export of {validateRuntimeProfileName} from the internal profile resolver. The gateway-runtime alias is preserved for callers that import via this package's barrel.
- **`GATEWAY_RUNTIME_REGISTRY`** — Curated runtime registry, exposed as a read-only `Record` so the selection layer can iterate and look up entries. The type is widened from the literal `as const` shape to `Readonly<Record<…>>` so d...
- **`HOME_PLACEHOLDER`** — Default directories the gateway prepends to `process.env.PATH` when resolving runtime binaries via the resolver in `./runtime-command-resolution.ts`. The host composition layer threads this list in...
- **`DEFAULT_EXTRA_BIN_PATHS`**
- **`MOCK_ACP_RUNTIME_ENV`** — Env var that gates registration of the in-repo `mock-acp` runtime in {listGatewayRuntimeIds}. Surfaced as a constant rather than an inline string so tests and consumers can reference the same key.
- **`defaultRuntimeCommandResolver`**
- **`EXTERNAL_RUNTIME_INSTALL_VERSIONS`** — Generated from `.versions.json` by `scripts/bump.ts`. Do not edit manually.
- **`CLAUDE_AGENT_ACP_PACKAGE_NAME`**
- **`CLAUDE_AGENT_ACP_VERSION`**
- **`CODEX_ACP_PACKAGE_NAME`**
- **`CODEX_ACP_VERSION`**
- **`SPAWN_SUB_SESSION_SUPPORTED_HARNESSES`** — Harness ids supported by `spawnSubSession` v1. Expand this set as harnesses land hardening gates for subagent spawning.
- **`SPAWN_SUB_SESSION_DEFAULT_HARNESS`** — Default harness used when `hints.harness` is unspecified.
- **`SPAWN_SUB_SESSION_DEFAULT_TIMEOUT_MS`** — Default subtask timeout (5 minutes).
- **`DEFAULT_AGENTS_JS_CONFIG`**

### Exports

- **`resolveAcpAgentEntryToRuntime`** — Stable public facade for gateway runtime lookup, command resolution, profile application, selection dispatch, and ACP-entry bridging. The implementations are split by responsibility: - `runtime-com...
- **`buildExtendedPath`**
- **`resolveGatewayRuntimeCommand`**
- **`createParseEnv`**
- **`EnvError`**
- **`OptionalEnvVar`**
- **`parseEnv`**
- **`RequiredEnvVar`**


## Dependencies

- `@agentclientprotocol/sdk`
- `@agents-js/a2a`
- `@agents-js/acp`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
