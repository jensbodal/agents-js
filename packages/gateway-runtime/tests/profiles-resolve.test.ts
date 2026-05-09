import { describe, expect, test } from "bun:test";
import path from "node:path";
import { resolveRuntimeProfile } from "../src/profiles/resolve.ts";

const ROOT = "/tmp/agents-js-profiles";

describe("resolveRuntimeProfile", () => {
  test("computes per-profile XDG roots from profilesRoot/runtime/name", () => {
    const resolved = resolveRuntimeProfile("clean-room", { runtime: "opencode" }, ROOT);

    const base = path.join(ROOT, "opencode", "clean-room");
    expect(resolved.roots).toEqual({
      home: base,
      config: path.join(base, ".config"),
      data: path.join(base, ".local", "share"),
      state: path.join(base, ".local", "state"),
      cache: path.join(base, ".cache"),
    });
  });

  test("env redirects HOME and four XDG_*_HOME vars", () => {
    const resolved = resolveRuntimeProfile("clean-room", { runtime: "opencode" }, ROOT);

    const base = path.join(ROOT, "opencode", "clean-room");
    expect(resolved.env).toEqual({
      HOME: base,
      XDG_CONFIG_HOME: path.join(base, ".config"),
      XDG_DATA_HOME: path.join(base, ".local", "share"),
      XDG_STATE_HOME: path.join(base, ".local", "state"),
      XDG_CACHE_HOME: path.join(base, ".cache"),
    });
  });

  test("profile-level env overlays on top of XDG env", () => {
    const resolved = resolveRuntimeProfile(
      "clean-room",
      {
        runtime: "opencode",
        env: { OPENCODE_PROFILE: "clean-room", OMO_DEBUG: "1" },
      },
      ROOT,
    );

    expect(resolved.env.OPENCODE_PROFILE).toBe("clean-room");
    expect(resolved.env.OMO_DEBUG).toBe("1");
    // XDG vars still present
    expect(resolved.env.XDG_CONFIG_HOME).toBe(path.join(ROOT, "opencode", "clean-room", ".config"));
  });

  test("profile-level env can override an XDG var", () => {
    // Operator may want to point one root at a shared cache, for example.
    const resolved = resolveRuntimeProfile(
      "shared-cache",
      {
        runtime: "opencode",
        env: { XDG_CACHE_HOME: "/var/cache/agents-js/shared" },
      },
      ROOT,
    );

    expect(resolved.env.XDG_CACHE_HOME).toBe("/var/cache/agents-js/shared");
  });

  test("explicit roots override the per-XDG defaults", () => {
    const resolved = resolveRuntimeProfile(
      "custom",
      {
        runtime: "opencode",
        roots: {
          home: "/custom/home",
          cache: "/custom/cache",
        },
      },
      ROOT,
    );

    // Overridden roots reflect the override.
    expect(resolved.roots.home).toBe("/custom/home");
    expect(resolved.roots.cache).toBe("/custom/cache");
    // Unspecified roots fall back to the per-profile defaults.
    expect(resolved.roots.config).toBe(path.join(ROOT, "opencode", "custom", ".config"));
    // env is built from `roots`, so the override flows through.
    expect(resolved.env.HOME).toBe("/custom/home");
    expect(resolved.env.XDG_CACHE_HOME).toBe("/custom/cache");
  });

  test("normalizes the profile name before computing paths", () => {
    const resolved = resolveRuntimeProfile("  clean-room  ", { runtime: "opencode" }, ROOT);
    expect(resolved.name).toBe("clean-room");
    expect(resolved.roots.home).toBe(path.join(ROOT, "opencode", "clean-room"));
  });

  test("rejects an invalid profile name", () => {
    expect(() => resolveRuntimeProfile("Bad Name", { runtime: "opencode" }, ROOT)).toThrow(
      'Profile names must contain only lowercase letters, numbers, "_" or "-".',
    );
  });

  test("definition.args is a copy (no aliasing of caller's array)", () => {
    const args = ["--foo"];
    const resolved = resolveRuntimeProfile("x", { runtime: "opencode", args }, ROOT);
    args.push("--mutated-after");
    expect(resolved.definition.args).toEqual(["--foo"]);
  });

  test("definition.env is a copy (no aliasing of caller's object)", () => {
    const env = { K: "v" };
    const resolved = resolveRuntimeProfile("x", { runtime: "opencode", env }, ROOT);
    env.K = "mutated";
    expect(resolved.definition.env).toEqual({ K: "v" });
    expect(resolved.env.K).toBe("v");
  });

  test("minimal profile (only runtime) does not throw", () => {
    const resolved = resolveRuntimeProfile("minimal", { runtime: "opencode" }, ROOT);
    expect(resolved.name).toBe("minimal");
    expect(resolved.definition.runtime).toBe("opencode");
  });
});
