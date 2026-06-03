import { describe, expect, test } from "bun:test";
import {
  applyRuntimeEnvOverrides,
  mergeRuntimeEnvOverrides,
} from "../src/runtime-env-overrides.ts";

describe("mergeRuntimeEnvOverrides", () => {
  test("returns a copy of base when no overrides are set", () => {
    const base = { FOO: "1", AJS_DEFAULT_MODEL: "existing" };
    const merged = mergeRuntimeEnvOverrides(base, {});
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
  });

  test("flag value takes precedence over pre-existing env (disableExternalPlugins)", () => {
    const merged = mergeRuntimeEnvOverrides(
      { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "0" },
      { disableExternalPlugins: true },
    );
    expect(merged.AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS).toBe("1");
  });

  test("explicit false override writes '0' (disables even when env says enabled)", () => {
    const merged = mergeRuntimeEnvOverrides(
      { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "1" },
      { disableExternalPlugins: false },
    );
    expect(merged.AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS).toBe("0");
  });

  test("undefined override preserves pre-existing env value", () => {
    const merged = mergeRuntimeEnvOverrides(
      {
        AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "1",
        AJS_RUNTIME_LOG_LEVEL: "debug",
        AJS_DEFAULT_HARNESS: "opencode",
        AJS_DEFAULT_MODEL: "model-a",
      },
      {},
    );
    expect(merged.AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS).toBe("1");
    expect(merged.AJS_RUNTIME_LOG_LEVEL).toBe("debug");
    expect(merged.AJS_DEFAULT_HARNESS).toBe("opencode");
    expect(merged.AJS_DEFAULT_MODEL).toBe("model-a");
  });

  test("runtimeLogLevel, defaultHarness overrides win over env", () => {
    const merged = mergeRuntimeEnvOverrides(
      {
        AJS_RUNTIME_LOG_LEVEL: "info",
        AJS_DEFAULT_HARNESS: "claude",
      },
      {
        runtimeLogLevel: "silent",
        defaultHarness: "opencode",
      },
    );
    expect(merged.AJS_RUNTIME_LOG_LEVEL).toBe("silent");
    expect(merged.AJS_DEFAULT_HARNESS).toBe("opencode");
  });

  test("shallow-merges unrelated keys from base", () => {
    const merged = mergeRuntimeEnvOverrides(
      { PATH: "/usr/bin", HOME: "/home/x" },
      { defaultHarness: "opencode" },
    );
    expect(merged.PATH).toBe("/usr/bin");
    expect(merged.HOME).toBe("/home/x");
    expect(merged.AJS_DEFAULT_HARNESS).toBe("opencode");
  });
});

describe("applyRuntimeEnvOverrides", () => {
  test("mutates target env and restore reverts to original values", () => {
    const target: NodeJS.ProcessEnv = {
      AJS_RUNTIME_LOG_LEVEL: "info",
      AJS_DEFAULT_HARNESS: "before",
      UNMANAGED: "keep-me",
    };

    const restore = applyRuntimeEnvOverrides(target, {
      runtimeLogLevel: "debug",
      defaultHarness: "after",
      disableExternalPlugins: true,
    });

    expect(target.AJS_RUNTIME_LOG_LEVEL).toBe("debug");
    expect(target.AJS_DEFAULT_HARNESS).toBe("after");
    expect(target.AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS).toBe("1");
    expect(target.UNMANAGED).toBe("keep-me");

    restore();

    expect(target.AJS_RUNTIME_LOG_LEVEL).toBe("info");
    expect(target.AJS_DEFAULT_HARNESS).toBe("before");
    expect(target.AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS).toBeUndefined();
    expect(target.UNMANAGED).toBe("keep-me");
  });

  test("restore removes keys that were not present in the original env", () => {
    const target: NodeJS.ProcessEnv = {};
    const restore = applyRuntimeEnvOverrides(target, {
      defaultHarness: "temporary",
    });
    expect(target.AJS_DEFAULT_HARNESS).toBe("temporary");
    restore();
    expect(target.AJS_DEFAULT_HARNESS).toBeUndefined();
  });
});
