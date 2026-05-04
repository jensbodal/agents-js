import {
  DEFAULT_INHERITED_ENV_KEYS,
  DEFAULT_TERMINAL_ENV_KEYS,
  SYSTEM_FORBIDDEN_ENV_KEYS,
} from "./constants.ts";

/**
 * Caller-supplied environment-variable policy. `acp-host` cannot know which
 * env vars are credentials for a given harness; embedders with that
 * knowledge populate this shape so the spawn-env builder forwards the right
 * keys to the agent process and excludes them from terminal commands.
 *
 * Every field is optional. When omitted, the host falls back to neutral
 * defaults that are safe for arbitrary ACP runtimes:
 *
 * - `inheritedEnvKeys` — copied from `process.env` into the spawned agent's
 *   env (e.g. `PATH`, `HOME`, `LANG`). Defaults to
 *   {@link DEFAULT_INHERITED_ENV_KEYS}.
 * - `agentSecretEnvKeys` — secrets copied into the agent process only,
 *   never into terminal commands. Defaults to `[]`; embedders supply the
 *   list (e.g. provider API keys + a baseline like
 *   `MATRIX_ACCESS_TOKEN` / `ANTHROPIC_API_KEY` if shared infra is in use).
 * - `terminalEnvKeys` — non-secret keys forwarded to terminal processes.
 *   Defaults to {@link DEFAULT_TERMINAL_ENV_KEYS}.
 * - `forbiddenExtraEnvKeys` — keys that agent config (`extraEnv`) must
 *   never override. Combined additively with
 *   {@link SYSTEM_FORBIDDEN_ENV_KEYS} (system loader guards) and
 *   `agentSecretEnvKeys` (so a fabricated value cannot replace a real
 *   credential coming from the parent process).
 */
export interface HostEnvPolicyInput {
  agentSecretEnvKeys?: readonly string[];
  forbiddenExtraEnvKeys?: readonly string[];
  inheritedEnvKeys?: readonly string[];
  terminalEnvKeys?: readonly string[];
}

/** Resolved view of {@link HostEnvPolicyInput} with defaults applied. */
export interface ResolvedHostEnvPolicy {
  agentSecretEnvKeys: readonly string[];
  forbiddenExtraEnvKeys: ReadonlySet<string>;
  inheritedEnvKeys: readonly string[];
  terminalEnvKeys: readonly string[];
}

export function resolveHostEnvPolicy(policy?: HostEnvPolicyInput): ResolvedHostEnvPolicy {
  const agentSecretEnvKeys = dedupe(policy?.agentSecretEnvKeys ?? []);
  const inheritedEnvKeys = dedupe(policy?.inheritedEnvKeys ?? DEFAULT_INHERITED_ENV_KEYS);
  const terminalEnvKeys = dedupe(policy?.terminalEnvKeys ?? DEFAULT_TERMINAL_ENV_KEYS);
  const forbiddenExtraEnvKeys = new Set<string>([
    ...SYSTEM_FORBIDDEN_ENV_KEYS,
    ...agentSecretEnvKeys,
    ...(policy?.forbiddenExtraEnvKeys ?? []),
  ]);
  return { agentSecretEnvKeys, forbiddenExtraEnvKeys, inheritedEnvKeys, terminalEnvKeys };
}

/**
 * Compute the set of env-var keys that callers must not override via agent
 * `extraEnv`. The result is the union of {@link SYSTEM_FORBIDDEN_ENV_KEYS},
 * the policy's `agentSecretEnvKeys`, and the policy's
 * `forbiddenExtraEnvKeys`. Useful for callers (e.g. CLI) that perform their
 * own env filtering and need the same guard set the host applies.
 */
export function buildForbiddenEnvKeys(policy?: HostEnvPolicyInput): ReadonlySet<string> {
  return resolveHostEnvPolicy(policy).forbiddenExtraEnvKeys;
}

function dedupe(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}
