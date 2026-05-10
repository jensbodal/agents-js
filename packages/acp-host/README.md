# @agents-js/acp-host

> Stateful ACP host embedding surface. Manages agent sessions, terminal processes, permissions, and file I/O for host applications.

## Installation

```sh
bun add @agents-js/acp-host
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`ACPSessionController`** — High-level session orchestrator for ACP agent communication. This is the top-level **Provider** for host applications. It composes an {ACPClientController} with host-level concerns: permission eval...
- **`AcpStreamingTranslator`** — Stateful per-session translator. Instantiate one per ACP session. The translator does no I/O and holds no transport handles — it's a pure data transformer with private accumulator state. Tests shou...
- **`CapabilityCache`** — Parses and caches agent capabilities from InitializeResponse. Provides boolean helpers for capability-gating UI and behavior. "Advertised" flags reflect what the CLIENT advertises to the agent. The...
- **`EvalTransport`** — `LogTransport` that captures per-prompt evaluation records (prompt content, response, stop reason, errors) for offline regression suites.
- **`Logger`** — Structured console logger with category prefixes. Provides debug visibility for session lifecycle, permissions, and errors. All log calls are also pushed to the global logStore for the debug panel.
- **`PermissionEngine`**
- **`PermissionStore`** — Persistence layer for permission rules. Session-scoped rules are held in memory. Persistent rules are saved via a host-provided callback.
- **`SpanLogTransport`** — `LogTransport` that buckets entries into spans keyed by `entry.spanId`, tracking active and completed spans for the debug panel and trace export.
- **`TerminalManager`**

### Functions

- **`applyAgentDefaults`**
- **`atomicWrite`** — Atomic CAS write: stages content to a temp file, verifies the target is unchanged since the last read, then renames the staging file into place. If `snapshot` is null (file was never read, or is a ...
- **`buildCompletedTurnSnapshot`**
- **`buildControllerAdapters`** — Build the `ACPHostAdapters` config object for `ACPClientController`. Wires each adapter closure to the session controller's internal handlers without exposing the full controller instance.
- **`buildForbiddenEnvKeys`** — Compute the set of env-var keys that callers must not override via agent `extraEnv`. The result is the union of {SYSTEM_FORBIDDEN_ENV_KEYS}, the policy's `agentSecretEnvKeys`, and the policy's `for...
- **`buildInlineContext`** — Builds inline text with file content embedded in a fenced code block.
- **`buildMcpServersList`** — Build the list of MCP servers to pass when creating or loading a session.
- **`buildMinimalEnv`**
- **`callHook`** — Safely invoke a session hook function. If the hook throws, the error is logged and `undefined` is returned.
- **`cancelPendingElicitation`** — Cancel a pending elicitation request by resolving it with "cancel" action. Emits an `elicitation_resolved` event if there was a pending request.
- **`cancelPendingPermission`** — Cancel a pending permission request by resolving it as "cancelled". Emits a `permission_resolved` event if there was a pending request.
- **`cancelPendingWriteGate`** — Cancel a pending write-gate request by resolving it as "reject". Emits a `write_gate_resolved` event if there was a pending gate.
- **`captureReadSnapshot`** — Capture a snapshot of a file for later CAS comparison. - Absolute path to the file (already resolved). A snapshot containing the content hash and mtime.
- **`cleanupStagingDir`** — Remove a session's staging directory. - Absolute path to the staging directory to remove.
- **`clearCancelSafetyTimer`** — Clear the cancel safety timer, if active. Returns `null` so the caller can assign back: `this.timer = clearCancelSafetyTimer(this.timer)`.
- **`clonePlanEntries`**
- **`clonePromptContent`**
- **`cloneTurnItems`**
- **`collectToolCallStats`**
- **`configureLogging`**
- **`createCrashableAgent`** — Creates a mock agent whose transport can be aborted mid-session. Useful for host crash/recovery tests that need a hard stream failure.
- **`createEchoAgent`**
- **`createFallbackModes`**
- **`createHangingAgent`**
- **`createHostACPProcess`**
- **`createInitialState`**
- **`createMockAgent`**
- **`createNodeFileAdapters`** — Creates {HostFileAdapters} that use Node.js `fs` APIs for file I/O. Relative paths resolve against the session cwd. Reads and writes are then enforced against the normalized read/write/scratch root...
- **`createOpencodeDefaultAgentRecoveredConfig`**
- **`createTerminalHandlers`** — Create a scoped set of terminal handlers backed by a dedicated TerminalManager. Each ACPSessionController should call this once and own the returned handlers.
- **`createTurnState`**
- **`deriveActivitySurface`**
- **`deriveComposerSurface`**
- **`deriveInterruptSurface`**
- **`derivePlanSurface`**
- **`deriveTerminalEntries`**
- **`deriveTranscriptSurface`**
- **`deriveWorkflowSurfaceState`**
- **`describeElicitationTarget`**
- **`describeQueuedFollowUpBoundary`**
- **`describeRunningTools`**
- **`describeWorkflowError`**
- **`detectFrontmatterOnlyWrite`**
- **`emitEvent`** — Emit an event to all registered listeners. Individual listener errors are caught and logged so one bad listener does not break others.
- **`emptyToolCallStats`**
- **`ensureStagingDir`** — Create the staging directory for a session under the configured scratch root. Idempotent -- safe to call multiple times. - Absolute path to the scratch root (for example `<workspace>/.tmp`). - Sess...
- **`evaluatePermission`** — Full permission evaluation pipeline: 1. beforePermission hook (fail-closed) 2. YOLO mode auto-approve 3. Read-only auto-approve 4. Remembered rules 5. Fall through to user prompt
- **`filterFiles`** — Filters open files by a query string (fuzzy match against name and basename).
- **`formatToolCallStatus`**
- **`getHostManagedPermissionReason`**
- **`getMentionAtCursor`** — Finds the mention token being typed at the cursor position in a textarea. Returns the query text after `@` (empty string if the user just typed `@`), or `null` if the cursor is not currently inside...
- **`getPromptQueueCount`**
- **`getToolCallById`**
- **`getToolCalls`**
- **`getTrailingToolBlockStats`**
- **`getValidMessageId`**
- **`handleSessionUpdate`** — Process a session notification and update state accordingly. Returns nothing -- all mutations happen on the `state` parameter.
- **`isOpencodeDefaultAgentMissing`**
- **`isSessionRestoreFailureMessage`**
- **`isWithinAnyWorkspaceRoot`**
- **`logPermissionDecision`** — Log a structured permission decision.
- **`mapToolCallContent`**
- **`mapToolCallStatus`**
- **`normalizeAgentName`**
- **`normalizeSessionModes`**
- **`parseMentions`** — Extracts mention tokens from text. Only matches tokens like `.md` at word boundaries (after whitespace, start of line, or after newline).
- **`requestWriteGateApproval`** — Determine whether a write should be auto-approved or requires a UI modal. Returns a resolved `Promise<boolean>` for auto-approved writes, or creates a pending write gate on `state` and emits the re...
- **`resetLogging`**
- **`resolveHostEnvPolicy`**
- **`resolveMentions`** — Resolves mention tokens to open file paths.
- **`resolveWorkflowCopy`** — Resolve a full copy map from optional partial overrides. Missing keys fall back to the default English copy.
- **`resolveWorkspaceContext`**
- **`resolveWorkspaceFilePath`**
- **`sandboxHomePath`** — Compute the deterministic sandbox HOME directory for a given workspace identity root. The hash ensures each logical workspace gets its own isolated HOME without collisions.
- **`snapshotToolCalls`**
- **`splitMarkdownFrontmatter`**
- **`summarizeToolGroup`**
- **`toWorkspaceDisplayPath`**
- **`trySetAgentMode`**
- **`waitForReady`** — Returns a promise that resolves when the session status becomes "ready", or rejects after the given timeout.

### Interfaces

- **`ACPSessionState`**
- **`AcpStreamingSink`** — Sink contract: consumers implement these methods to receive translated streaming events. Methods are invoked synchronously; the sink owns any downstream async dispatch (e.g. publishing on an event ...
- **`ActivitySurfaceState`**
- **`AgentConfig`**
- **`ApplyDefaultsResult`**
- **`AvailableCommandsUpdateCall`** — Argument shape for `AcpStreamingSink.onAvailableCommandsUpdate`. Carries the FULL set of commands available from the harness via the SDK's typed `AvailableCommand` shape (preserves description, inp...
- **`BuildMinimalEnvInput`**
- **`CodeDescriptor`** — A code block with language annotation
- **`CompletedToolCallSnapshot`**
- **`CompletedTurnSnapshot`**
- **`ComponentDescriptor`** — An escape hatch for host-specific components
- **`ComposerSurfaceState`**
- **`ControllerAdapterContext`**
- **`CreateTerminalHandlersOptions`**
- **`DependencyRegistry`** — Registry for querying host-provided integrations and capabilities at runtime. This is an **Adapter** interface that host platforms can implement to advertise available services (MCP servers, extern...
- **`DiffDescriptor`** — A file diff
- **`DirectoryPolicy`** — Directory policy: what the agent is ALLOWED to read, write, and stage to, plus the auto-approved write zones that bypass the write-gate modal. This is intentionally separate from {WorkspaceContextC...
- **`EvalRecord`**
- **`FileSnapshot`** — Snapshot of a file's content hash and modification time, captured after a read for later CAS comparison.
- **`FormDescriptor`** — A form rendered inline (not as a modal) — for read-only display of elicitation results
- **`HostACPProcessOptions`** — Host-specific process spawn options, extending the low-level `ACPProcessOptions` from `-js/acp` with fields that only `createHostACPProcess` (in this package) interprets. `workspaceFlag` lived on `...
- **`HostElicitationAdapter`** — Optional elicitation adapter that the host platform can provide to handle agent elicitation requests (e.g., form-based user input). If omitted, the session controller manages elicitation state inte...
- **`HostEnvPolicyInput`** — Caller-supplied environment-variable policy. `acp-host` cannot know which env vars are credentials for a given harness; embedders with that knowledge populate this shape so the spawn-env builder fo...
- **`HostFileAdapters`** — File I/O adapters that the host platform must implement. The writeTextFile adapter receives a `requestApproval` callback for write-gate approval flows.
- **`HostSessionStorageAdapter`** — Optional session storage adapter for persisting session state across backend restarts. Required for seamless transcript reloading if the host process crashes or restarts.
- **`IntegrationStatus`**
- **`InterruptActionState`**
- **`InterruptSurfaceState`**
- **`JsonRpcError`**
- **`JsonRpcRequest`** — MCP protocol types for the local workspace MCP server. Covers JSON-RPC 2.0 request/response shapes and MCP tool definitions needed for the HTTP transport. These are intentionally minimal -- only wh...
- **`JsonRpcResponse`**
- **`LogEntry`**
- **`LoggerConfig`**
- **`LogTransport`** — Sink for structured log entries. Implementors handle each `LogEntry` synchronously (any async work must be self-managed) and decide where it goes — console, span buffer, eval transport, or a host-s...
- **`ManagedTerminal`**
- **`McpInitializeResult`**
- **`McpPropertySchema`**
- **`McpToolCallParams`**
- **`McpToolCallResult`**
- **`McpToolContent`**
- **`McpToolDefinition`**
- **`McpToolInputSchema`**
- **`McpToolsListResult`**
- **`ModeChangeCall`** — Argument shape for `AcpStreamingSink.onModeChange`. ACP `current_mode_update` notifications only carry `currentModeId` (the available-modes list lives in initial session metadata, not on transition...
- **`ModeSyncResult`**
- **`NodeFileAdapterOptions`**
- **`NormalizedAgentName`**
- **`PendingElicitation`**
- **`PendingPermission`**
- **`PendingWriteGate`**
- **`PermissionDecision`**
- **`PermissionEvaluationContext`**
- **`PlanEntryInfo`**
- **`PlanSurfaceState`**
- **`PlanUpdateCall`** — Argument shape for `AcpStreamingSink.onPlanUpdate`. ACP `plan` notifications always carry the FULL set of entries — consumers replace plan state wholesale on receipt. Entries reuse the SDK's typed ...
- **`RenderHint`** — Metadata hint that can be attached to ACP session_update _meta fields to suggest structured rendering for tool call outputs.
- **`ResolvedHostEnvPolicy`** — Resolved view of {HostEnvPolicyInput} with defaults applied.
- **`ResolvedWorkspaceContext`**
- **`SessionHooks`**
- **`SessionInfoUpdateCall`** — Argument shape for `AcpStreamingSink.onSessionInfoUpdate`. Mirrors ACP `SessionInfoUpdate` (title + updatedAt). Both fields are `string | null | undefined` per the SDK: `null` is an explicit clear ...
- **`SessionUpdateContentHandlerHooks`**
- **`Span`**
- **`StartConfig`** — Configuration for starting an ACP session controller. Replaces the old positional parameters with a structured config object.
- **`TerminalDescriptor`** — Terminal output
- **`TerminalHandlers`**
- **`TerminalManagerOptions`**
- **`TerminalWorkspaceContext`**
- **`TextDeltaCall`** — Argument shape for `AcpStreamingSink.onTextDelta` and `onThoughtDelta`. Both `delta` (incremental text added by this chunk) and `cumulativeText` (running total per `messageId`) are surfaced so sink...
- **`TextDescriptor`** — A text block rendered as markdown
- **`ToolBlockSurfaceState`**
- **`ToolCallContentHandler`**
- **`ToolCallContentHandlerContext`**
- **`ToolCallContentInfo`** — Flattened ACP `ToolCallContent` representation. The SDK's `ToolCallContent` is a discriminated union of three nested shapes (`content`, `diff`, `terminal`); this type pulls the relevant fields up s...
- **`ToolCallInfo`**
- **`ToolCallStartCall`** — Argument shape for `AcpStreamingSink.onToolCallStart`.
- **`ToolCallSummary`**
- **`ToolCallUpdateCall`** — Argument shape for `AcpStreamingSink.onToolCallUpdate`. Mirrors the ACP `ToolCallUpdate` shape with three-state semantics for `content` / `locations`: `undefined` = no change, `null` = explicit cle...
- **`TranscriptSurfaceState`**
- **`TurnState`**
- **`UsageUpdateCall`** — Argument shape for `AcpStreamingSink.onUsageUpdate`.
- **`WorkflowActivityEntryState`**
- **`WorkflowCopyMap`** — Type-safe interface for all workflow surface UI copy strings. Consumers may supply a partial override to customize any subset of strings.
- **`WorkflowErrorSummary`**
- **`WorkflowPendingPermissionLike`**
- **`WorkflowPendingWriteGateLike`**
- **`WorkflowPlanEntryState`**
- **`WorkflowSessionStateLike`**
- **`WorkflowStatusOverride`**
- **`WorkflowSurfaceContext`**
- **`WorkflowSurfaceState`**
- **`WorkflowToolCallLike`**
- **`WorkflowToolCallStats`**
- **`WorkflowToolGroupSummary`**
- **`WorkflowTurnStateLike`**
- **`WorkspaceContext`**
- **`WorkspaceContextConfig`**
- **`WorkspaceContextProvider`**

### Types

- **`ACPSessionEvent`**
- **`ACPSessionStatus`**
- **`AgentScenario`**
- **`ElicitationScenario`**
- **`FrontmatterWriteTarget`** — Browser-safe entry point for -js/acp-host/editor. The mention-parser helpers and the frontmatter-only-write detector are pure framework-agnostic TypeScript functions with no Node-specific runtime d...
- **`Listener`**
- **`LogCategory`**
- **`LogLevel`**
- **`ModeFallbackReason`**
- **`OpenFileEntry`**
- **`PermissionLifetime`**
- **`PermissionMode`** — Permission mode controlling the host's auto-approve/prompt strategy.
- **`PromptScenario`**
- **`ReadonlySpan`**
- **`RenderDescriptor`** — Discriminated union of all render descriptor types
- **`SessionInfo`**
- **`TurnItem`** — Ordered item in a turn -- preserves interleaving of text and tool calls
- **`WorkflowActivityKind`**
- **`WorkflowActivityPhase`**
- **`WorkflowActivityStatus`**
- **`WorkflowComposerMode`**
- **`WorkflowInterruptBlocker`**
- **`WorkflowSurfaceSeverity`**
- **`WriteGateResolution`** — Resolution returned by the write-gate modal UI.

### Constants

- **`DEFAULT_AGENT_CONFIG`**
- **`DEFAULT_INHERITED_ENV_KEYS`** — Default non-secret keys inherited from the host environment into the spawned agent process. Hosts can override the inherited set via {HostEnvPolicyInput.inheritedEnvKeys}; secret credentials (provi...
- **`DEFAULT_TERMINAL_ENV_KEYS`** — Default subset of {DEFAULT_INHERITED_ENV_KEYS} forwarded to terminal processes. SHELL is excluded because terminals spawn with `shell: false` (direct argv invocation), so the SHELL variable would b...
- **`defaultWorkflowCopy`** — Default English copy map used when no overrides are provided.
- **`DEV_AGENT_CONFIG`**
- **`JSON_RPC_INTERNAL_ERROR`**
- **`JSON_RPC_INVALID_PARAMS`**
- **`JSON_RPC_INVALID_REQUEST`**
- **`JSON_RPC_METHOD_NOT_FOUND`**
- **`JSON_RPC_PARSE_ERROR`**
- **`logStore`** — Singleton log store instance.
- **`SESSION_RESTORE_FAILURE_MESSAGE`**
- **`SYSTEM_FORBIDDEN_ENV_KEYS`** — System/loader keys that agent config (`extraEnv`) must never override. These guards apply regardless of the harness or caller-supplied policy because they protect the spawned process's loader contr...

### Exports

- **`type BuildMinimalEnvInput`**
- **`type NormalizedAgentName`**


## Dependencies

- `@agentclientprotocol/sdk`
- `@agents-js/acp`
- `@agents-js/policy`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
