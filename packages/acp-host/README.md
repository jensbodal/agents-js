# @agents-js/acp-host

> Stateful ACP host embedding surface. Manages agent sessions, terminal processes, permissions, and file I/O for host applications.

## Installation

```sh
bun add @agents-js/acp-host
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`CapabilityCache`** — Parses and caches agent capabilities from InitializeResponse. Provides boolean helpers for capability-gating UI and behavior. "Advertised" flags reflect what the CLIENT advertises to the agent. The...
- **`PermissionEngine`**
- **`PermissionStore`** — Persistence layer for permission rules. Session-scoped rules are held in memory. Persistent rules are saved via a host-provided callback.
- **`ACPSessionController`** — High-level session orchestrator for ACP agent communication. This is the top-level **Provider** for host applications. It composes an {ACPClientController} with host-level concerns: permission eval...
- **`TerminalManager`**
- **`SpanLogTransport`**
- **`EvalTransport`**

### Functions

- **`createNodeFileAdapters`** — Creates {HostFileAdapters} that use Node.js `fs` APIs for file I/O. Relative paths resolve against the session cwd. Reads and writes are then enforced against the normalized read/write/scratch root...
- **`describeElicitationTarget`**
- **`describeQueuedFollowUpBoundary`**
- **`getPromptQueueCount`**
- **`deriveTerminalEntries`**
- **`describeWorkflowError`**
- **`deriveActivitySurface`**
- **`deriveInterruptSurface`**
- **`deriveComposerSurface`**
- **`emptyToolCallStats`**
- **`getToolCalls`**
- **`getToolCallById`**
- **`describeRunningTools`**
- **`collectToolCallStats`**
- **`formatToolCallStatus`**
- **`getTrailingToolBlockStats`**
- **`summarizeToolGroup`**
- **`deriveTranscriptSurface`**
- **`derivePlanSurface`**
- **`applyAgentDefaults`**
- **`trySetAgentMode`**
- **`cancelPendingPermission`** — Cancel a pending permission request by resolving it as "cancelled". Emits a `permission_resolved` event if there was a pending request.
- **`cancelPendingElicitation`** — Cancel a pending elicitation request by resolving it with "cancel" action. Emits an `elicitation_resolved` event if there was a pending request.
- **`cancelPendingWriteGate`** — Cancel a pending write-gate request by resolving it as "reject". Emits a `write_gate_resolved` event if there was a pending gate.
- **`clearCancelSafetyTimer`** — Clear the cancel safety timer, if active. Returns `null` so the caller can assign back: `this.timer = clearCancelSafetyTimer(this.timer)`.
- **`buildMcpServersList`** — Build the list of MCP servers to pass when creating or loading a session.
- **`handleSessionUpdate`** — Process a session notification and update state accordingly. Returns nothing -- all mutations happen on the `state` parameter.
- **`deriveWorkflowSurfaceState`**
- **`normalizeAgentName`**
- **`sandboxHomePath`** — Compute the deterministic sandbox HOME directory for a given workspace identity root. The hash ensures each logical workspace gets its own isolated HOME without collisions.
- **`buildMinimalEnv`**
- **`createHostACPProcess`**
- **`createInitialState`**
- **`createTurnState`**
- **`getValidMessageId`**
- **`clonePromptContent`**
- **`clonePlanEntries`**
- **`cloneTurnItems`**
- **`snapshotToolCalls`**
- **`buildCompletedTurnSnapshot`**
- **`mapToolCallStatus`**
- **`mapToolCallContent`**
- **`buildControllerAdapters`** — Build the `ACPHostAdapters` config object for `ACPClientController`. Wires each adapter closure to the session controller's internal handlers without exposing the full controller instance.
- **`resolveWorkspaceContext`**
- **`isWithinAnyWorkspaceRoot`**
- **`resolveWorkspaceFilePath`**
- **`toWorkspaceDisplayPath`**
- **`createTerminalHandlers`** — Create a scoped set of terminal handlers backed by a dedicated TerminalManager. Each ACPSessionController should call this once and own the returned handlers.
- **`resolveWorkflowCopy`** — Resolve a full copy map from optional partial overrides. Missing keys fall back to the default English copy.
- **`isOpencodeDefaultAgentMissing`**
- **`createOpencodeDefaultAgentRecoveredConfig`**
- **`captureReadSnapshot`** — Capture a snapshot of a file for later CAS comparison. - Absolute path to the file (already resolved). A snapshot containing the content hash and mtime.
- **`atomicWrite`** — Atomic CAS write: stages content to a temp file, verifies the target is unchanged since the last read, then renames the staging file into place. If `snapshot` is null (file was never read, or is a ...
- **`ensureStagingDir`** — Create the staging directory for a session under the configured scratch root. Idempotent -- safe to call multiple times. - Absolute path to the scratch root (for example `<workspace>/.tmp`). - Sess...
- **`cleanupStagingDir`** — Remove a session's staging directory. - Absolute path to the staging directory to remove.
- **`createMockAgent`**
- **`createCrashableAgent`** — Creates a mock agent whose transport can be aborted mid-session. Useful for host crash/recovery tests that need a hard stream failure.
- **`createEchoAgent`**
- **`createHangingAgent`**
- **`configureLogging`**
- **`resetLogging`**
- **`isSessionRestoreFailureMessage`**
- **`callHook`** — Safely invoke a session hook function. If the hook throws, the error is logged and `undefined` is returned.
- **`logPermissionDecision`** — Log a structured permission decision.
- **`evaluatePermission`** — Full permission evaluation pipeline: 1. beforePermission hook (fail-closed) 2. YOLO mode auto-approve 3. Read-only auto-approve 4. Remembered rules 5. Fall through to user prompt
- **`resolveHostEnvPolicy`**
- **`buildForbiddenEnvKeys`** — Compute the set of env-var keys that callers must not override via agent `extraEnv`. The result is the union of {SYSTEM_FORBIDDEN_ENV_KEYS}, the policy's `agentSecretEnvKeys`, and the policy's `for...
- **`emitEvent`** — Emit an event to all registered listeners. Individual listener errors are caught and logged so one bad listener does not break others.
- **`waitForReady`** — Returns a promise that resolves when the session status becomes "ready", or rejects after the given timeout.
- **`createFallbackModes`**
- **`normalizeSessionModes`**
- **`getHostManagedPermissionReason`**
- **`requestWriteGateApproval`** — Determine whether a write should be auto-approved or requires a UI modal. Returns a resolved `Promise<boolean>` for auto-approved writes, or creates a pending write gate on `state` and emits the re...
- **`filterFiles`** — Filters open files by a query string (fuzzy match against name and basename).
- **`parseMentions`** — Extracts mention tokens from text. Only matches tokens like `.md` at word boundaries (after whitespace, start of line, or after newline).
- **`resolveMentions`** — Resolves mention tokens to open file paths.
- **`buildInlineContext`** — Builds inline text with file content embedded in a fenced code block.
- **`getMentionAtCursor`** — Finds the mention token being typed at the cursor position in a textarea. Returns the query text after `@` (empty string if the user just typed `@`), or `null` if the cursor is not currently inside...

### Interfaces

- **`NodeFileAdapterOptions`**
- **`ApplyDefaultsResult`**
- **`ModeSyncResult`**
- **`HostSessionStorageAdapter`** — Optional session storage adapter for persisting session state across backend restarts. Required for seamless transcript reloading if the host process crashes or restarts.
- **`HostElicitationAdapter`** — Optional elicitation adapter that the host platform can provide to handle agent elicitation requests (e.g., form-based user input). If omitted, the session controller manages elicitation state inte...
- **`HostFileAdapters`** — File I/O adapters that the host platform must implement. The writeTextFile adapter receives a `requestApproval` callback for write-gate approval flows.
- **`StartConfig`** — Configuration for starting an ACP session controller. Replaces the old positional parameters with a structured config object.
- **`PermissionDecision`**
- **`WorkspaceContext`**
- **`WorkspaceContextProvider`**
- **`IntegrationStatus`**
- **`DependencyRegistry`** — Registry for querying host-provided integrations and capabilities at runtime. This is an **Adapter** interface that host platforms can implement to advertise available services (MCP servers, extern...
- **`ToolCallContentHandlerContext`**
- **`ToolCallContentHandler`**
- **`TextDescriptor`** — A text block rendered as markdown
- **`CodeDescriptor`** — A code block with language annotation
- **`DiffDescriptor`** — A file diff
- **`TerminalDescriptor`** — Terminal output
- **`FormDescriptor`** — A form rendered inline (not as a modal) — for read-only display of elicitation results
- **`ComponentDescriptor`** — An escape hatch for host-specific components
- **`RenderHint`** — Metadata hint that can be attached to ACP session_update _meta fields to suggest structured rendering for tool call outputs.
- **`JsonRpcRequest`** — MCP protocol types for the local workspace MCP server. Covers JSON-RPC 2.0 request/response shapes and MCP tool definitions needed for the HTTP transport. These are intentionally minimal -- only wh...
- **`JsonRpcResponse`**
- **`JsonRpcError`**
- **`McpToolDefinition`**
- **`McpToolInputSchema`**
- **`McpPropertySchema`**
- **`McpToolsListResult`**
- **`McpToolCallParams`**
- **`McpToolCallResult`**
- **`McpToolContent`**
- **`McpInitializeResult`**
- **`WorkflowActivityEntryState`**
- **`WorkflowPlanEntryState`**
- **`PlanSurfaceState`**
- **`ActivitySurfaceState`**
- **`InterruptActionState`**
- **`InterruptSurfaceState`**
- **`ComposerSurfaceState`**
- **`ToolBlockSurfaceState`**
- **`TranscriptSurfaceState`**
- **`WorkflowSurfaceState`**
- **`WorkflowStatusOverride`**
- **`WorkflowSurfaceContext`**
- **`WorkflowToolCallStats`**
- **`WorkflowToolCallLike`**
- **`WorkflowPendingPermissionLike`**
- **`WorkflowPendingWriteGateLike`**
- **`WorkflowTurnStateLike`**
- **`WorkflowSessionStateLike`**
- **`WorkflowErrorSummary`**
- **`WorkflowToolGroupSummary`**
- **`ACPSessionState`**
- **`CompletedToolCallSnapshot`**
- **`CompletedTurnSnapshot`**
- **`TurnState`**
- **`ToolCallInfo`**
- **`PlanEntryInfo`**
- **`ToolCallContentInfo`**
- **`PendingPermission`**
- **`PendingElicitation`**
- **`PendingWriteGate`**
- **`HostACPProcessOptions`** — Host-specific process spawn options, extending the low-level `ACPProcessOptions` from `-js/acp` with fields that only `createHostACPProcess` (in this package) interprets. `workspaceFlag` lived on `...
- **`AgentConfig`**
- **`ToolCallSummary`**
- **`SessionHooks`**
- **`SessionUpdateContentHandlerHooks`**
- **`ManagedTerminal`**
- **`TerminalManagerOptions`**
- **`NormalizedAgentName`**
- **`BuildMinimalEnvInput`**
- **`ControllerAdapterContext`**
- **`DirectoryPolicy`** — Directory policy: what the agent is ALLOWED to read, write, and stage to, plus the auto-approved write zones that bypass the write-gate modal. This is intentionally separate from {WorkspaceContextC...
- **`WorkspaceContextConfig`**
- **`ResolvedWorkspaceContext`**
- **`TerminalWorkspaceContext`**
- **`TerminalHandlers`**
- **`CreateTerminalHandlersOptions`**
- **`WorkflowCopyMap`** — Type-safe interface for all workflow surface UI copy strings. Consumers may supply a partial override to customize any subset of strings.
- **`FileSnapshot`** — Snapshot of a file's content hash and modification time, captured after a read for later CAS comparison.
- **`LogEntry`**
- **`LogTransport`**
- **`LoggerConfig`**
- **`Span`**
- **`EvalRecord`**
- **`PermissionEvaluationContext`**
- **`HostEnvPolicyInput`** — Caller-supplied environment-variable policy. `acp-host` cannot know which env vars are credentials for a given harness; embedders with that knowledge populate this shape so the spawn-env builder fo...
- **`ResolvedHostEnvPolicy`** — Resolved view of {HostEnvPolicyInput} with defaults applied.
- **`OpenFileEntry`**

### Types

- **`PermissionLifetime`**
- **`RenderDescriptor`** — Discriminated union of all render descriptor types
- **`WorkflowSurfaceSeverity`**
- **`WorkflowComposerMode`**
- **`WorkflowActivityPhase`**
- **`WorkflowActivityKind`**
- **`WorkflowActivityStatus`**
- **`WorkflowInterruptBlocker`**
- **`ACPSessionStatus`**
- **`TurnItem`** — Ordered item in a turn -- preserves interleaving of text and tool calls
- **`WriteGateResolution`** — Resolution returned by the write-gate modal UI.
- **`ACPSessionEvent`**
- **`PermissionMode`**
- **`ElicitationScenario`**
- **`PromptScenario`**
- **`AgentScenario`**
- **`LogCategory`**
- **`LogLevel`**
- **`ReadonlySpan`**
- **`Listener`**
- **`SessionInfo`**
- **`ModeFallbackReason`**
- **`FrontmatterWriteTarget`** — Browser-safe entry point for -js/acp-host/editor. The mention-parser helpers and the frontmatter-only-write detector are pure framework-agnostic TypeScript functions with no Node-specific runtime d...

### Constants

- **`JSON_RPC_PARSE_ERROR`**
- **`JSON_RPC_INVALID_REQUEST`**
- **`JSON_RPC_METHOD_NOT_FOUND`**
- **`JSON_RPC_INVALID_PARAMS`**
- **`JSON_RPC_INTERNAL_ERROR`**
- **`defaultWorkflowCopy`** — Default English copy map used when no overrides are provided.
- **`logStore`** — Singleton log store instance
- **`SESSION_RESTORE_FAILURE_MESSAGE`**
- **`DEFAULT_INHERITED_ENV_KEYS`** — Default non-secret keys inherited from the host environment into the spawned agent process. Hosts can override the inherited set via {HostEnvPolicyInput.inheritedEnvKeys}; secret credentials (provi...
- **`DEFAULT_TERMINAL_ENV_KEYS`** — Default subset of {DEFAULT_INHERITED_ENV_KEYS} forwarded to terminal processes. SHELL is excluded because terminals spawn with `shell: false` (direct argv invocation), so the SHELL variable would b...
- **`SYSTEM_FORBIDDEN_ENV_KEYS`** — System/loader keys that agent config (`extraEnv`) must never override. These guards apply regardless of the harness or caller-supplied policy because they protect the spawned process's loader contr...

### Exports

- **`DEFAULT_AGENT_CONFIG`** — Browser-safe entry point for -js/acp-host. The main entry (src/index.ts) re-exports the full host surface, which transitively pulls in Node-only dependencies (filesystem adapters, child-process hel...
- **`DEV_AGENT_CONFIG`** — Browser-safe entry point for -js/acp-host. The main entry (src/index.ts) re-exports the full host surface, which transitively pulls in Node-only dependencies (filesystem adapters, child-process hel...
- **`Logger`**
- **`type NormalizedAgentName`**
- **`type BuildMinimalEnvInput`**
- **`detectFrontmatterOnlyWrite`**
- **`splitMarkdownFrontmatter`**


## Dependencies

- `@agentclientprotocol/sdk`
- `@agents-js/acp`
- `@agents-js/policy`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
