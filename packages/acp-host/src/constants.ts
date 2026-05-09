import type { AgentConfig } from "./types/agent-config.ts";

export const DEFAULT_AGENT_CONFIG: Omit<AgentConfig, "command"> = {
  name: "Claude (ACP)",
  args: ["acp"],
  env: {},
  authHints: [],
  workspacePolicy: "workspace-root-only",
};

export const DEV_AGENT_CONFIG: Omit<AgentConfig, "command"> = {
  name: "Plugin Dev (ACP)",
  args: ["acp"],
  env: {},
  authHints: [],
  workspacePolicy: "workspace-root-only",
  additionalPaths: [],
  builtIn: true,
};

/**
 * Default non-secret keys inherited from the host environment into the
 * spawned agent process. Hosts can override the inherited set via
 * {@link HostEnvPolicyInput.inheritedEnvKeys}; secret credentials (provider
 * API keys, access tokens) belong in
 * {@link HostEnvPolicyInput.agentSecretEnvKeys} so they can be excluded from
 * terminal commands while still reaching the agent.
 */
export const DEFAULT_INHERITED_ENV_KEYS: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "SHELL",
]);

/**
 * Default subset of {@link DEFAULT_INHERITED_ENV_KEYS} forwarded to terminal
 * processes. SHELL is excluded because terminals spawn with `shell: false`
 * (direct argv invocation), so the SHELL variable would be misleading and
 * unused.
 */
export const DEFAULT_TERMINAL_ENV_KEYS: readonly string[] = Object.freeze(
  DEFAULT_INHERITED_ENV_KEYS.filter((k) => k !== "SHELL"),
);

/**
 * System/loader keys that agent config (`extraEnv`) must never override.
 * These guards apply regardless of the harness or caller-supplied policy
 * because they protect the spawned process's loader contract from injection
 * attacks; they are intentionally additive to any caller-provided
 * {@link HostEnvPolicyInput.forbiddenExtraEnvKeys}.
 */
export const SYSTEM_FORBIDDEN_ENV_KEYS: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
]);
