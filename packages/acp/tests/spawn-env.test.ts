import { describe, expect, test } from "bun:test";
import { buildSpawnEnv } from "../src/connection.ts";

/**
 * `buildSpawnEnv` decides what env reaches a spawned ACP child. Without
 * an explicit whitelist, `spawnACPAgent` would otherwise leak the full
 * `process.env` into every child. The contract:
 *
 *   1. With `inheritedEnvKeys` undefined (legacy callers), behavior
 *      is unchanged: full parent env merged with overrides.
 *   2. With `inheritedEnvKeys` supplied, ONLY those keys are copied
 *      from the parent; overrides layer on top.
 *   3. Empty whitelist + no overrides → empty env (the "isolate
 *      everything" extreme).
 */
const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/op",
  ANTHROPIC_API_KEY: "secret-anthropic",
  MATRIX_ACCESS_TOKEN: "secret-matrix",
  CODEX_API_KEY: "secret-codex",
  RANDOM_DEV_VAR: "should-not-leak",
};

describe("buildSpawnEnv", () => {
  test("undefined whitelist preserves legacy full-inherit behavior", () => {
    const result = buildSpawnEnv(PARENT_ENV, { env: { CUSTOM: "x" } });
    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.RANDOM_DEV_VAR).toBe("should-not-leak");
    expect(result.CUSTOM).toBe("x");
  });

  test("explicit whitelist drops everything else from process.env", () => {
    const result = buildSpawnEnv(PARENT_ENV, {
      inheritedEnvKeys: ["PATH", "HOME", "ANTHROPIC_API_KEY"],
    });
    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.HOME).toBe("/home/op");
    expect(result.ANTHROPIC_API_KEY).toBe("secret-anthropic");
    // Regression case — credentials for other runtimes must not
    // reach a child whose runtime did not declare them.
    expect(result.CODEX_API_KEY).toBeUndefined();
    expect(result.MATRIX_ACCESS_TOKEN).toBeUndefined();
    expect(result.RANDOM_DEV_VAR).toBeUndefined();
  });

  test("env overrides layer on top of the whitelisted keys", () => {
    const result = buildSpawnEnv(PARENT_ENV, {
      inheritedEnvKeys: ["PATH"],
      env: { ANTHROPIC_API_KEY: "explicit-override", FROM_RUNTIME: "yes" },
    });
    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.ANTHROPIC_API_KEY).toBe("explicit-override");
    expect(result.FROM_RUNTIME).toBe("yes");
  });

  test("empty whitelist + no overrides produces an empty env", () => {
    const result = buildSpawnEnv(PARENT_ENV, { inheritedEnvKeys: [] });
    expect(Object.keys(result)).toEqual([]);
  });

  test("missing parent keys are silently skipped (no undefined leak)", () => {
    const result = buildSpawnEnv(PARENT_ENV, {
      inheritedEnvKeys: ["PATH", "DOES_NOT_EXIST"],
    });
    expect(Object.hasOwn(result, "DOES_NOT_EXIST")).toBe(false);
    expect(result.PATH).toBe("/usr/bin:/bin");
  });
});
