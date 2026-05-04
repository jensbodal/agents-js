import type {
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationCapabilities,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type { ACPProcess } from "@agents-js/acp";
import type { HostEnvPolicyInput } from "../env-policy.ts";
import type { PermissionEngine } from "../permission-engine.ts";
import type { PermissionStore } from "../permission-store.ts";
import type { WorkspaceContextConfig } from "../workspace-context.ts";
import type { AgentConfig } from "./agent-config.ts";
import type { SessionHooks } from "./hooks.ts";
import type { DependencyRegistry } from "./host-adapters.ts";
import type { HostACPProcessOptions } from "./process-options.ts";
import type { ACPSessionState } from "./session.ts";
import type { ToolCallContentHandler } from "./tool-call-content-handler.ts";

/**
 * Optional session storage adapter for persisting session state across backend restarts.
 * Required for seamless transcript reloading if the host process crashes or restarts.
 */
export interface HostSessionStorageAdapter {
  saveSession(sessionId: string, state: ACPSessionState): Promise<void>;
  loadSession(sessionId: string): Promise<ACPSessionState | null>;
}

/**
 * Optional elicitation adapter that the host platform can provide to handle
 * agent elicitation requests (e.g., form-based user input).
 *
 * If omitted, the session controller manages elicitation state internally
 * and exposes it via `pendingElicitation` / `resolveElicitation()`.
 *
 * If provided, the adapter receives elicitation requests directly and
 * bypasses the session controller's built-in state management.
 */
export interface HostElicitationAdapter {
  request(params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  complete?(params: CompleteElicitationNotification): Promise<void>;
  capabilities?: ElicitationCapabilities;
}

/**
 * File I/O adapters that the host platform must implement.
 * The writeTextFile adapter receives a `requestApproval` callback
 * for write-gate approval flows.
 */
export interface HostFileAdapters {
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(
    params: WriteTextFileRequest,
    requestApproval: (gate: {
      path: string;
      diff: string;
      absolutePath?: string;
    }) => Promise<boolean>,
  ): Promise<WriteTextFileResponse>;
}

/**
 * Configuration for starting an ACP session controller.
 * Replaces the old positional parameters with a structured config object.
 */
export interface StartConfig extends WorkspaceContextConfig {
  agentConfig: AgentConfig;
  /**
   * Legacy single-path workspace input.
   *
   * When explicit workspace-context fields are omitted, this path is used as:
   * - the workspace identity root
   * - the session cwd
   * - the default read/write root
   * - the base for the default `.tmp` scratch root
   */
  workspacePath: string;
  fileAdapters: HostFileAdapters;
  permissionEngine?: PermissionEngine;
  permissionStore?: PermissionStore;
  createProcess?: (options: HostACPProcessOptions) => ACPProcess;
  mcpServerUrl?: string;
  /** Display name for the MCP server passed to the agent (defaults to "workspace") */
  mcpServerName?: string;
  /** Additional directories to add to PATH when spawning the agent process */
  extraBinPaths?: string[];
  /**
   * Caller-supplied env-var policy applied to both the spawned ACP agent
   * process and any terminal commands the agent requests. The host has no
   * harness knowledge, so embedders pass the per-runtime auth-key set (and
   * optional overrides for inherited / terminal / forbidden keys) here.
   * See {@link HostEnvPolicyInput}.
   */
  envPolicy?: HostEnvPolicyInput;
  /** Optional registry for querying host-provided integrations and capabilities */
  dependencyRegistry?: DependencyRegistry;
  /** Client identification sent during ACP initialization */
  clientInfo?: { name: string; version: string };
  /** Optional session lifecycle hooks for extensibility */
  hooks?: SessionHooks;
  /** Optional elicitation adapter for handling agent elicitation requests */
  elicitation?: HostElicitationAdapter;
  /** Optional tool-call content handlers for custom host-side content plumbing. */
  toolCallContentHandlers?: ToolCallContentHandler[];
  /** Optional session storage adapter for persisting session state across backend restarts */
  sessionStorage?: HostSessionStorageAdapter;
  /** Timeout in ms for prompt responses (default: 3600000 / 1 hour). Set to 0 to disable. */
  promptTimeoutMs?: number;
}
