/**
 * Per-harness default config loader.
 *
 * Loads `defaults/<harness>.json` files that declare env vars and
 * sessionEnvKeys for each supported harness. Removes magic strings
 * from plan.ts builders — adding a new default is a config change,
 * not a code change.
 *
 * Shape per defaults file:
 *   { "env": { "KEY": "value" }, "sessionEnvKeys": ["KEY"] }
 *
 * - `env`: static key=value pairs merged into the launch env.
 *   Dynamic values (e.g. AGENTS_JS_PI_NAME computed from MATRIX_AGENT)
 *   stay in code — defaults only carry static entries.
 * - `sessionEnvKeys`: keys the launcher lifts into tmux sessionEnv.
 *
 * Missing files return empty (no error). The caller decides whether
 * a harness requires defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolved directory holding defaults JSON files (sibling of src/). */
export const DEFAULTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../defaults",
);

/** Parsed shape of a harness defaults file. */
export interface HarnessDefaults {
  /** Static env vars merged into the launch env. Operator baseEnv wins. */
  readonly env: Readonly<Record<string, string>>;
  /** Keys from env (or computed env) that the launcher lifts into sessionEnv. */
  readonly sessionEnvKeys: readonly string[];
}

/** Empty defaults returned when no file exists for a harness. */
const EMPTY_DEFAULTS: HarnessDefaults = Object.freeze({
  env: Object.freeze({}),
  sessionEnvKeys: Object.freeze([]),
});

/**
 * Load harness defaults from `defaults/<harness>.json`.
 *
 * Returns empty defaults when the file does not exist (non-harness-specific
 * callers should not need to know which harnesses have defaults).
 * Throws on malformed JSON or unexpected shapes.
 */
export function loadHarnessDefaults(harness: string): HarnessDefaults {
  const filePath = path.join(DEFAULTS_DIR, `${harness}.json`);
  if (!existsSync(filePath)) {
    return EMPTY_DEFAULTS;
  }

  const raw = readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[agent-launch] defaults file ${filePath} contains invalid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[agent-launch] defaults file ${filePath} must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  // Validate env
  if (obj.env !== undefined) {
    if (typeof obj.env !== "object" || obj.env === null || Array.isArray(obj.env)) {
      throw new Error(`[agent-launch] defaults file ${filePath}: "env" must be an object`);
    }
    for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new Error(
          `[agent-launch] defaults file ${filePath}: env["${k}"] must be a string, got ${typeof v}`,
        );
      }
    }
  } else {
    obj.env = {};
  }

  // Validate sessionEnvKeys
  if (obj.sessionEnvKeys !== undefined) {
    if (!Array.isArray(obj.sessionEnvKeys)) {
      throw new Error(
        `[agent-launch] defaults file ${filePath}: "sessionEnvKeys" must be an array`,
      );
    }
    for (const entry of obj.sessionEnvKeys as unknown[]) {
      if (typeof entry !== "string") {
        throw new Error(
          `[agent-launch] defaults file ${filePath}: sessionEnvKeys entries must be strings`,
        );
      }
    }
  } else {
    obj.sessionEnvKeys = [];
  }

  return Object.freeze({
    env: Object.freeze({ ...(obj.env as Record<string, string>) }),
    sessionEnvKeys: Object.freeze([...(obj.sessionEnvKeys as string[])]),
  });
}
