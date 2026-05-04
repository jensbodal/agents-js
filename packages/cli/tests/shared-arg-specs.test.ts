import { describe, expect, test } from "bun:test";
import {
  type HarnessArg,
  type HostPortArgs,
  harnessArg,
  hostPortArgs,
  type RuntimeLogArgs,
  type RuntimeSelectArgs,
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
