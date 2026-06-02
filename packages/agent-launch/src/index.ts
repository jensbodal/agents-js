/**
 * `@agents-js/agent-launch` — typed launcher for agents-js-managed
 * tmux/harness sessions. Phase 1 of the AJS-141 migration: replaces
 * the dot-cognee `scripts/agent-launch.sh` bash original in phased
 * increments.
 *
 * **Phase 1 scope** (per vault plan
 * `agents-js-agent-launch-cli-migration-plan-2026-05-26.md`):
 *
 * - Config loader + schema validation (`loadLaunchConfig`,
 *   `resolveAgentEntry`)
 * - Plan builder for `claude-code` harness in `"fresh"` mode
 *   (`buildLaunchPlan`)
 * - Identity env composition for git author + MATRIX_AGENT only
 *   (`injectIdentityEnv`)
 * - Tmux wrapper around `spawnSync` with no shell interpolation
 *   (`createTmuxRunner`)
 *
 * **Out of scope for Phase 1** (deferred to later phases):
 * - Other harnesses (codex-cli, opencode, kiro-cli) — Phase 2
 * - Matrix-token injection + gemini ACP symlinks — Phase 3
 * - Status / list / sessions / JSON status — Phase 4
 * - Resume mode + dot-cognee cutover shim — Phase 5
 *
 * **5-question defaults committed** (no re-litigation):
 *
 * 1. Package name: `@agents-js/agent-launch`
 * 2. Config search path: `--config <path>` → `AGENTS_JS_LAUNCH_CONFIG`
 *    → `~/.config/agents-js/agent-launch-config.json` →
 *    `./agent-launch-config.json` (CLI resolves; this package consumes
 *    the resolved path)
 * 3. Tmux: required; hard-fail if not on PATH (matches bash original)
 * 4. JSON schema: preserve verbatim through Phase 4 (only matters
 *    Phase 4+)
 * 5. Cutover sequencing: Phase 5 concern, documented + deferred
 *
 * @packageDocumentation
 */

export {
  type AgentEntry,
  type LaunchConfig,
  LaunchConfigError,
  loadLaunchConfig,
  parseLaunchConfig,
  resolveAgentEntry,
} from "./config.ts";
export {
  IdentityEnvError,
  injectIdentityEnv,
  type LaunchEnv,
  parseEnvSetup,
} from "./identity.ts";
export {
  type AgentIdentity,
  deriveRuntimeHost,
  HARNESS_TOKEN_TO_KIND,
  HARNESS_TOKENS,
  type HarnessToken,
  parseAgentIdentity,
} from "./identity-scheme.ts";
export {
  type BuildLaunchPlanOptions,
  buildLaunchPlan,
  type LaunchMode,
  type LaunchPlan,
  LaunchPlanError,
  type SupportedHarness,
} from "./plan.ts";
export {
  createTmuxRunner,
  type TmuxRunner,
  type TmuxRunnerOptions,
  type TmuxSpawner,
  type TmuxSpawnResult,
} from "./tmux.ts";
