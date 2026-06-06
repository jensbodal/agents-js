// -- Atomic write infrastructure ----------------------------------------------
export {
  atomicWrite,
  captureReadSnapshot,
  cleanupStagingDir,
  ensureStagingDir,
  type FileSnapshot,
} from "./atomic-write.ts";

// -- Classes ------------------------------------------------------------------

// -- SDK re-exports -----------------------------------------------------------
// NOTE: editor symbols (parseMentions, buildInlineContext, etc. and the
// FrontmatterWriteTarget / OpenFileEntry types) are NOT re-exported here.
// Consumers should import them directly from @agents-js/acp-host/editor so
// the root host surface stays focused on ACP sessions and host adapters.
export type { SessionInfo } from "@agentclientprotocol/sdk";
// -- Agent name normalization -------------------------------------------------
export { type NormalizedAgentName, normalizeAgentName } from "./agent-name-normalize.ts";
export { CapabilityCache } from "./capability-cache.ts";
// -- Constants ----------------------------------------------------------------
export {
  DEFAULT_AGENT_CONFIG,
  DEFAULT_INHERITED_ENV_KEYS,
  DEFAULT_TERMINAL_ENV_KEYS,
  DEV_AGENT_CONFIG,
  SYSTEM_FORBIDDEN_ENV_KEYS,
} from "./constants.ts";
// -- Env policy ---------------------------------------------------------------
export {
  buildForbiddenEnvKeys,
  type HostEnvPolicyInput,
  type ResolvedHostEnvPolicy,
  resolveHostEnvPolicy,
} from "./env-policy.ts";
export type {
  EvalRecord,
  LogCategory,
  LogEntry,
  LoggerConfig,
  LogLevel,
  LogTransport,
  ReadonlySpan,
  Span,
} from "./logger.ts";
export {
  configureLogging,
  EvalTransport,
  Logger,
  logStore,
  resetLogging,
  SpanLogTransport,
} from "./logger.ts";
export type { NodeFileAdapterOptions } from "./node-file-adapters.ts";
export { createNodeFileAdapters } from "./node-file-adapters.ts";
export { PermissionEngine } from "./permission-engine.ts";
export { PermissionStore } from "./permission-store.ts";
// -- Functions ----------------------------------------------------------------
export { type BuildMinimalEnvInput, buildMinimalEnv, createHostACPProcess } from "./process.ts";
export type { PermissionMode } from "./session-controller.ts";
export { ACPSessionController } from "./session-controller.ts";
export { normalizePermissionMode } from "./session-state.ts";
export {
  createTerminalHandlers,
  type TerminalHandlers,
  type TerminalWorkspaceContext,
} from "./terminal-handlers.ts";
export type { ManagedTerminal } from "./terminal-manager.ts";
// -- Terminal manager ---------------------------------------------------------
export { TerminalManager } from "./terminal-manager.ts";
export type {
  HostElicitationAdapter,
  HostFileAdapters,
  HostSessionStorageAdapter,
  StartConfig,
} from "./types/adapters.ts";
// -- Config types -------------------------------------------------------------
export type { AgentConfig } from "./types/agent-config.ts";
// -- Session hooks ------------------------------------------------------------
export type { SessionHooks, ToolCallSummary } from "./types/hooks.ts";
// -- Host-generic adapter interfaces ------------------------------------------
export type {
  DependencyRegistry,
  IntegrationStatus,
  PermissionDecision,
  PermissionLifetime,
  WorkspaceContext,
  WorkspaceContextProvider,
} from "./types/host-adapters.ts";
// -- MCP types ----------------------------------------------------------------
export type {
  JsonRpcError,
  JsonRpcRequest,
  JsonRpcResponse,
  McpInitializeResult,
  McpPropertySchema,
  McpToolCallParams,
  McpToolCallResult,
  McpToolContent,
  McpToolDefinition,
  McpToolInputSchema,
  McpToolsListResult,
} from "./types/mcp.ts";
export {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
} from "./types/mcp.ts";
export type { HostACPProcessOptions } from "./types/process-options.ts";
// -- Render descriptors (AG-UI layer 3) ---------------------------------------
export type {
  CodeDescriptor,
  ComponentDescriptor,
  DiffDescriptor,
  FormDescriptor,
  RenderDescriptor,
  RenderHint,
  TerminalDescriptor,
  TextDescriptor,
} from "./types/render-descriptor.ts";
// -- Session types ------------------------------------------------------------
export type {
  ACPSessionEvent,
  ACPSessionState,
  ACPSessionStatus,
  CompletedToolCallSnapshot,
  CompletedTurnSnapshot,
  PendingElicitation,
  PendingPermission,
  PendingWriteGate,
  PlanEntryInfo,
  ProcessExitInfo,
  ToolCallContentInfo,
  ToolCallInfo,
  TurnItem,
  TurnState,
  WriteGateResolution,
} from "./types/session.ts";
export type {
  ToolCallContentHandler,
  ToolCallContentHandlerContext,
} from "./types/tool-call-content-handler.ts";
export type {
  ActivitySurfaceState,
  ComposerSurfaceState,
  InterruptActionState,
  InterruptSurfaceState,
  PlanSurfaceState,
  ToolBlockSurfaceState,
  TranscriptSurfaceState,
  WorkflowActivityEntryState,
  WorkflowActivityKind,
  WorkflowActivityPhase,
  WorkflowActivityStatus,
  WorkflowComposerMode,
  WorkflowErrorSummary,
  WorkflowInterruptBlocker,
  WorkflowPlanEntryState,
  WorkflowSessionStateLike,
  WorkflowStatusOverride,
  WorkflowSurfaceContext,
  WorkflowSurfaceSeverity,
  WorkflowSurfaceState,
  WorkflowToolCallLike,
  WorkflowToolCallStats,
  WorkflowToolGroupSummary,
  WorkflowTurnStateLike,
} from "./types/workflow-surface.ts";
export type { WorkflowCopyMap } from "./workflow-copy.ts";
export { defaultWorkflowCopy, resolveWorkflowCopy } from "./workflow-copy.ts";
export {
  collectToolCallStats,
  deriveWorkflowSurfaceState,
  describeWorkflowError,
  formatToolCallStatus,
  getTrailingToolBlockStats,
  summarizeToolGroup,
} from "./workflow-surfaces.ts";
export type {
  DirectoryPolicy,
  ResolvedWorkspaceContext,
  WorkspaceContextConfig,
} from "./workspace-context.ts";
export {
  isWithinAnyWorkspaceRoot,
  resolveWorkspaceContext,
  resolveWorkspaceFilePath,
  toWorkspaceDisplayPath,
} from "./workspace-context.ts";
