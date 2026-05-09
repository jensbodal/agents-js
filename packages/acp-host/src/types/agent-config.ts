export interface AgentConfig {
  /** Display name for this agent configuration */
  name: string;
  /** Command to spawn the ACP agent process */
  command: string;
  /** Arguments passed to the command */
  args: string[];
  /** Extra environment variables merged with the process env */
  env: Record<string, string>;
  /** Non-secret reference strings describing required auth context for this agent */
  authHints: string[];
  /** Workspace policy posture. v1 supports only workspace-root-only. */
  workspacePolicy: "workspace-root-only";
  /** Additional directories the agent can access beyond workspace root */
  additionalPaths?: string[];
  /** Whether this is a built-in agent config (not user-removable) */
  builtIn?: boolean;
  /** Default mode to activate when starting a session (e.g. "plan", "default"). Applied if the agent advertises this mode. */
  defaultMode?: string;
  /** Default model to use when starting a session. Applied if the agent advertises this model. @experimental */
  defaultModel?: string;
  /**
   * @deprecated Use `StartConfig.directoryPolicy.autoApprovedWriteFolders`
   * (or the inline `StartConfig.autoApprovedWriteFolders` field) instead.
   * Carried per-AgentConfig to preserve backward compatibility for hosts
   * that have not yet migrated. When both are provided, the session-level
   * directory-policy field wins; this field is merged in as a fallback.
   *
   * Workspace-identity-relative folders where the agent can write without
   * approval. Mixing agent-level and session-level concerns; the directory
   * policy belongs on the session, not on the spawn config.
   */
  writableFolders?: string[];
  /** CLI flag name for passing workspace directory (default: "--directory") */
  workspaceFlag?: string;
  /** When true, pass the real HOME to the agent process instead of a sandboxed temp directory. Required for external runtimes that store credentials under ~/.config/. */
  allowRealHome?: boolean;
  /**
   * Explicit opt-in for opencode-specific auto-recovery in the session
   * controller: on `session/new` failing with `-32603 default agent "..." not
   * found`, restart the underlying process with `--pure` appended and retry
   * once. Set only for the opencode curated profile. See
   * `HostACPProcessOptions.autoRecoverOpencodeDefaultAgent` for the mirror
   * field on the runtime-resolver side.
   */
  autoRecoverOpencodeDefaultAgent?: boolean;
}
