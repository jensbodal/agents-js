import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentsJsConfig,
  DEFAULT_AGENTS_JS_CONFIG,
  loadAgentsJsConfig,
  mergeAgentsJsConfig,
  parseAgentsJsConfig,
  writeAgentsJsConfig,
} from "../src/config.ts";

// The config file is the user-facing contract for `agents-js` runtime
// behavior. parseAgentsJsConfig validates raw input → throws clear errors;
// mergeAgentsJsConfig defines precedence between user-level and project-level
// configs; load/write round-trip ensures on-disk state survives the cycle.

describe("parseAgentsJsConfig", () => {
  test("accepts a minimal empty object", () => {
    expect(parseAgentsJsConfig({}, "test.json")).toEqual({
      extraBinPaths: undefined,
      profiles: undefined,
      serve: undefined,
    });
  });

  test("rejects non-object input with a path-bearing error", () => {
    expect(() => parseAgentsJsConfig("string", "/conf/test.json")).toThrow(/test.json/);
    expect(() => parseAgentsJsConfig(42, "/conf/test.json")).toThrow();
    expect(() => parseAgentsJsConfig(null, "/conf/test.json")).toThrow();
  });

  test("rejects a harness without a recognized kind", () => {
    expect(() =>
      parseAgentsJsConfig({ serve: { harness: { kind: "weird" } } }, "test.json"),
    ).toThrow();
  });

  test("accepts a curated harness with runtime", () => {
    const result = parseAgentsJsConfig(
      { serve: { harness: { kind: "curated", runtime: "claude" } } },
      "test.json",
    );
    expect(result.serve?.harness).toEqual({
      kind: "curated",
      runtime: "claude",
      profile: undefined,
    });
  });

  test("rejects a curated harness missing runtime", () => {
    expect(() =>
      parseAgentsJsConfig({ serve: { harness: { kind: "curated" } } }, "test.json"),
    ).toThrow();
  });

  test("rejects custom harness with empty command", () => {
    expect(() =>
      parseAgentsJsConfig({ serve: { harness: { kind: "custom", command: "" } } }, "test.json"),
    ).toThrow();
  });

  test("rejects invalid selectionPolicy", () => {
    expect(() =>
      parseAgentsJsConfig({ serve: { selectionPolicy: "always" } }, "test.json"),
    ).toThrow();
  });

  test("accepts both supported selectionPolicy values", () => {
    expect(
      parseAgentsJsConfig({ serve: { selectionPolicy: "ask-each-time" } }, "test.json").serve
        ?.selectionPolicy,
    ).toBe("ask-each-time");
    expect(
      parseAgentsJsConfig({ serve: { selectionPolicy: "prefer-saved" } }, "test.json").serve
        ?.selectionPolicy,
    ).toBe("prefer-saved");
  });
});

describe("mergeAgentsJsConfig — precedence", () => {
  test("project serve overrides user serve", () => {
    const user: AgentsJsConfig = { serve: { host: "user-host", port: 1111 } };
    const project: AgentsJsConfig = { serve: { host: "project-host" } };
    const merged = mergeAgentsJsConfig(user, project);
    // host comes from project, port falls through from user (project did not set it)
    expect(merged.serve?.host).toBe("project-host");
    expect(merged.serve?.port).toBe(1111);
  });

  test("project extraBinPaths replaces user (no concat)", () => {
    const user: AgentsJsConfig = { extraBinPaths: ["/user/bin"] };
    const project: AgentsJsConfig = { extraBinPaths: ["/project/bin"] };
    expect(mergeAgentsJsConfig(user, project).extraBinPaths).toEqual(["/project/bin"]);
  });

  test("USER profile env wins over PROJECT profile env (security default)", () => {
    // user-level env vars (e.g. API keys) are intentionally not overridable
    // by project-level config files. Pinning this so a refactor doesn't
    // silently flip the precedence and let a project file shadow a user secret.
    const user: AgentsJsConfig = {
      profiles: { foo: { runtime: "claude", env: { SECRET: "user-value", USER_ONLY: "yes" } } },
    };
    const project: AgentsJsConfig = {
      profiles: {
        foo: { runtime: "claude", env: { SECRET: "project-value", PROJECT_ONLY: "yes" } },
      },
    };
    const merged = mergeAgentsJsConfig(user, project).profiles?.foo;
    expect(merged?.env).toEqual({
      SECRET: "user-value", // user wins on shared keys
      USER_ONLY: "yes",
      PROJECT_ONLY: "yes",
    });
  });

  test("returns the populated config when one side is undefined", () => {
    const user: AgentsJsConfig = { extraBinPaths: ["/user/bin"] };
    expect(mergeAgentsJsConfig(user, undefined).extraBinPaths).toEqual(["/user/bin"]);
    expect(mergeAgentsJsConfig(undefined, user).extraBinPaths).toEqual(["/user/bin"]);
  });
});

describe("loadAgentsJsConfig + writeAgentsJsConfig — round-trip", () => {
  test("writing then loading reproduces the config", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agents-js-config-test-"));
    try {
      const projectConfigPath = path.join(dir, ".agents-js", "config.json");
      const written: AgentsJsConfig = {
        extraBinPaths: ["/round-trip/bin"],
        serve: {
          host: "127.0.0.1",
          port: 4242,
          harness: { kind: "curated", runtime: "claude" },
        },
      };
      await writeAgentsJsConfig(projectConfigPath, written);

      const loaded = await loadAgentsJsConfig({
        cwd: dir,
        env: { HOME: dir }, // route the user-config path away from the real $HOME
        homeDir: dir,
      });

      expect(loaded.projectConfig).toEqual(written);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns DEFAULT_AGENTS_JS_CONFIG-derived effectiveConfig when no files exist", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agents-js-config-empty-"));
    try {
      const loaded = await loadAgentsJsConfig({ cwd: dir, env: { HOME: dir }, homeDir: dir });
      expect(loaded.userConfig).toBeUndefined();
      expect(loaded.projectConfig).toBeUndefined();
      // The effective config inherits the DEFAULT serve.harness
      expect(loaded.effectiveConfig.serve?.harness).toEqual(
        DEFAULT_AGENTS_JS_CONFIG.serve?.harness as never,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
