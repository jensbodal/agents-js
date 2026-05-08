import { describe, expect, test } from "bun:test";
import {
  type HarnessArg,
  type HostPortArgs,
  harnessArg,
  hostPortArgs,
  type RegistrySyncArg,
  type RuntimeLogArgs,
  type RuntimeSelectArgs,
  registrySyncArg,
  runtimeLogArgs,
  runtimeSelectArgs,
} from "../src/shared-arg-specs.ts";

describe("hostPortArgs", () => {
  test("declares --host and --port", () => {
    const spec = hostPortArgs<HostPortArgs>();
    expect(Object.keys(spec).sort()).toEqual(["--host", "--port"]);
    expect(spec["--host"]?.kind).toBe("value");
    expect(spec["--port"]?.kind).toBe("value");
  });

  test("--host assigns the raw string and --port parses an integer", () => {
    const spec = hostPortArgs<HostPortArgs>();
    const acc: HostPortArgs = {};
    spec["--host"]?.assign(acc, "127.0.0.1");
    spec["--port"]?.assign(acc, "61001");
    expect(acc).toEqual({ host: "127.0.0.1", port: 61001 });
  });
});

describe("runtimeLogArgs", () => {
  test("declares the runtime log/env flag set", () => {
    const spec = runtimeLogArgs<RuntimeLogArgs>();
    expect(Object.keys(spec).sort()).toEqual([
      "--default-model",
      "--opencode-disable-external-plugins",
      "--runtime-log-level",
    ]);
    expect(spec["--runtime-log-level"]?.kind).toBe("value");
    expect(spec["--default-model"]?.kind).toBe("value");
    expect(spec["--opencode-disable-external-plugins"]?.kind).toBe("flag");
  });

  test("--opencode-disable-external-plugins flips the boolean knob", () => {
    const spec = runtimeLogArgs<RuntimeLogArgs>();
    const acc: RuntimeLogArgs = {};
    const entry = spec["--opencode-disable-external-plugins"];
    if (entry?.kind !== "flag") throw new Error("expected flag entry");
    entry.assign(acc);
    expect(acc.opencodeDisableExternalPlugins).toBe(true);
  });
});

describe("harnessArg", () => {
  test("declares --harness only", () => {
    const spec = harnessArg<HarnessArg>();
    expect(Object.keys(spec)).toEqual(["--harness"]);
    expect(spec["--harness"]?.kind).toBe("value");
  });

  test("--harness assigns the raw string", () => {
    const spec = harnessArg<HarnessArg>();
    const acc: HarnessArg = {};
    spec["--harness"]?.assign(acc, "claude");
    expect(acc.harness).toBe("claude");
  });
});

describe("registrySyncArg", () => {
  test("declares --registry-sync as a flag", () => {
    const spec = registrySyncArg<RegistrySyncArg>();
    expect(Object.keys(spec)).toEqual(["--registry-sync"]);
    expect(spec["--registry-sync"]?.kind).toBe("flag");
  });

  test("--registry-sync flips the boolean knob to true", () => {
    const spec = registrySyncArg<RegistrySyncArg>();
    const acc: RegistrySyncArg = {};
    const entry = spec["--registry-sync"];
    if (entry?.kind !== "flag") throw new Error("expected flag entry");
    entry.assign(acc);
    expect(acc.registrySync).toBe(true);
  });

  test("default state leaves the knob undefined (sync stays off)", () => {
    const acc: RegistrySyncArg = {};
    expect(acc.registrySync).toBeUndefined();
  });
});

describe("runtimeSelectArgs", () => {
  test("composes harness with the full runtime-selection flag set", () => {
    const spec = runtimeSelectArgs<RuntimeSelectArgs>();
    expect(Object.keys(spec).sort()).toEqual([
      "--acp-args-json",
      "--acp-command",
      "--harness",
      "--profile",
    ]);
    expect(spec["--harness"]?.kind).toBe("value");
    expect(spec["--acp-command"]?.kind).toBe("value");
    expect(spec["--acp-args-json"]?.kind).toBe("value");
    expect(spec["--profile"]?.kind).toBe("value");
  });
});

/**
 * Each `ArgEntry` may carry an optional `description` and (for value
 * entries) an optional `valueExample`. Both feed
 * `docs/_generated/cli-command-table.md` directly. These pin the
 * representative shape so the partial generator's contract holds.
 */
describe("ArgEntry description + valueExample contract", () => {
  test("hostPortArgs entries carry a non-empty description and a valueExample", () => {
    const spec = hostPortArgs<HostPortArgs>();
    const port = spec["--port"];
    if (port?.kind !== "value") throw new Error("expected --port to be a value entry");
    expect(typeof port.description).toBe("string");
    expect(port.description?.length ?? 0).toBeGreaterThan(0);
    expect(typeof port.valueExample).toBe("string");
    expect(port.valueExample?.length ?? 0).toBeGreaterThan(0);
  });

  test("runtimeLogArgs --runtime-log-level carries a description with the level set", () => {
    const spec = runtimeLogArgs<RuntimeLogArgs>();
    const level = spec["--runtime-log-level"];
    if (level?.kind !== "value")
      throw new Error("expected --runtime-log-level to be a value entry");
    expect(level.description).toContain("debug");
    expect(level.description).toContain("silent");
  });

  test("harnessArg --harness carries a non-empty description", () => {
    const spec = harnessArg<HarnessArg>();
    const h = spec["--harness"];
    if (h?.kind !== "value") throw new Error("expected --harness to be a value entry");
    expect(typeof h.description).toBe("string");
    expect(h.description?.length ?? 0).toBeGreaterThan(0);
  });
});
