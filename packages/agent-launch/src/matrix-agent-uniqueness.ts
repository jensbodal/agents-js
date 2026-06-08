/**
 * Phase 1 of write-time MATRIX_AGENT uniqueness (#37 / ADR #75, cognee-claude
 * DRI). A duplicated MATRIX_AGENT means two launched sessions share one fleet
 * identity — gopass/memory/credential paths keyed on the name then collide.
 * This guard rejects that at launch time, before the second session spawns.
 *
 * **Phasing** (ADR #75): Phase 1 (this module) enforces uniqueness within a
 * single launch config's entry set — the authoritative, I/O-free source. Phase
 * 2 (gated) extends to fleet-wide cross-box uniqueness against the fleet-root
 * signed trust manifest (`packages/host/src/load-trust-manifest.ts`,
 * `loadTrustManifest` → `PeerKeyDirectory` / `loadedEntities`), once onboard
 * provisioning populates it with `entity == MATRIX_AGENT` records. The unsigned
 * per-host registry (`~/.agents-js/registry.json`) is never the authority — at
 * most an advisory liveness hint.
 *
 * **Critique-first reasoning**
 *
 * - **Boundary**: pure + I/O-free. Operates on the already-loaded
 *   {@link LaunchConfig}; no filesystem, no spawns. The orchestration layer
 *   (`packages/cli/src/launch.ts`) calls this; `identity.ts` stays a pure
 *   per-entry function with no cross-entry awareness.
 * - **Default**: uniqueness is enforced only among entries that actually
 *   declare a MATRIX_AGENT. An entry with no `env_setup` / no MATRIX_AGENT
 *   export declares no fleet identity and is never a claimant.
 * - **Contract**: throws {@link MatrixAgentCollisionError} iff the SELECTED
 *   agent is one of ≥2 equal co-claimants. Reject-all-co-claimants (not
 *   first-wins): the error names the MATRIX_AGENT + every conflicting
 *   tmuxSession so the operator fixes the config, never silently picking a
 *   winner. A clean selected agent is never blocked by an unrelated dup among
 *   OTHER entries ("continue launching non-colliders").
 * - **Safety**: NO auto-suffix — silent identity mutation breaks
 *   name-keyed credential/memory paths. The cross-entry scan reads other
 *   entries permissively ({@link extractMatrixAgent} never throws), so a live
 *   config mixing non-Phase-1 profiles (codex without `fresh_flags`, virtual
 *   profiles with nulls) is never whole-file-rejected — preserving the lazy
 *   normalization invariant from PR #99.
 * - **Validation**: unit tests cover extraction (simple/quoted/absent/
 *   shell-expanded), unique pass, declares-none pass, 2-way + 3-way
 *   collisions, clean-selected-amid-unrelated-dup pass, and the documented
 *   shell-expansion limitation.
 */

import type { LaunchConfig } from "./config.ts";

/** One agent laying claim to a MATRIX_AGENT identity in the launch config. */
export interface MatrixAgentCoClaimant {
  /** The agent's config key (the `agents` map key). */
  readonly agentName: string;
  /** The agent's `tmux_session`, or its config key when that field is absent. */
  readonly tmuxSession: string;
}

/**
 * Raised when the selected agent's MATRIX_AGENT identity is also declared by
 * another entry in the same launch config. Carries the identity + the full
 * co-claimant set for actionable diagnostics.
 */
export class MatrixAgentCollisionError extends Error {
  readonly matrixAgent: string;
  readonly claimants: readonly MatrixAgentCoClaimant[];
  constructor(matrixAgent: string, claimants: readonly MatrixAgentCoClaimant[]) {
    const sessions = claimants.map((c) => c.tmuxSession).join(", ");
    super(
      `[agents-js launch-identity] MATRIX_AGENT "${matrixAgent}" is claimed by ${claimants.length} ` +
        `agents in the launch config (sessions: ${sessions}). Each agent must have a unique ` +
        `MATRIX_AGENT — two sessions sharing one identity collide on name-keyed credential, ` +
        `memory, and routing paths. Fix the config so only one entry exports ` +
        `MATRIX_AGENT=${matrixAgent}.`,
    );
    this.name = "MatrixAgentCollisionError";
    this.matrixAgent = matrixAgent;
    this.claimants = claimants;
  }
}

/** Read a string field from a raw (un-normalized) config entry, else undefined. */
function readRawString(raw: unknown, field: string): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Best-effort extraction of an entry's exported MATRIX_AGENT value from its
 * `env_setup` snippet. Permissive by design — returns `undefined` (never
 * throws) for an absent, empty, or shell-expanded value — so a uniqueness scan
 * over the full config never aborts on an unrelated non-Phase-1 entry.
 *
 * Recognizes `export MATRIX_AGENT=value` (optionally double/single quoted),
 * split on the same `\n`/`;`/`&&` separators as {@link parseEnvSetup}. Values
 * using command substitution (`$(...)`, backticks) or variable expansion
 * (`$VAR`) cannot be statically resolved and yield `undefined` rather than a
 * guessed identity.
 */
export function extractMatrixAgent(envSetup: string | undefined): string | undefined {
  if (envSetup === undefined) return undefined;
  const segments = envSetup
    .split(/[\n;]|&&/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const segment of segments) {
    const match = segment.match(/^export\s+MATRIX_AGENT=(.*)$/);
    if (!match) continue;
    let value = (match[1] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Shell expansion / command substitution can't be statically resolved —
    // treat as "no determinable identity" rather than risk a false match.
    if (value.includes("$(") || value.includes("`")) return undefined;
    if (/(?<!\\)\$/.test(value)) return undefined;
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Assert the SELECTED agent's MATRIX_AGENT identity is unique within the
 * launch config (ADR #75 Phase 1). Pure + I/O-free.
 *
 * Throws {@link MatrixAgentCollisionError} iff the selected agent declares a
 * MATRIX_AGENT that ≥1 other entry also declares (the selected agent is one of
 * ≥2 equal co-claimants). Passes silently when the selected agent declares no
 * MATRIX_AGENT or its value is unique — and an unrelated dup among OTHER
 * entries never blocks a clean selected agent.
 */
export function assertSelectedMatrixAgentUnique(config: LaunchConfig, selectedName: string): void {
  const selectedMatrixAgent = extractMatrixAgent(
    readRawString(config.agents[selectedName], "env_setup"),
  );
  // No declared fleet identity → nothing to enforce for this launch.
  if (selectedMatrixAgent === undefined) return;

  const claimants: MatrixAgentCoClaimant[] = [];
  for (const [agentName, raw] of Object.entries(config.agents)) {
    if (extractMatrixAgent(readRawString(raw, "env_setup")) === selectedMatrixAgent) {
      claimants.push({ agentName, tmuxSession: readRawString(raw, "tmux_session") ?? agentName });
    }
  }

  if (claimants.length > 1) {
    claimants.sort((a, b) => a.tmuxSession.localeCompare(b.tmuxSession));
    throw new MatrixAgentCollisionError(selectedMatrixAgent, claimants);
  }
}
