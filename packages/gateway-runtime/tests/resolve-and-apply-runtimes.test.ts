import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getPrimaryGatewayRuntime,
  resolveAndApplyGatewayRuntimes,
} from "../src/resolve-and-apply.ts";
import type {
  GatewayRuntimeSelection,
  ResolvedGatewayRuntime,
  RuntimeCommandResolver,
} from "../src/runtimes-registry.ts";

// AJS-7 PR1 plural variant. Covers:
//   - single-entry list = byte-identical to pre-AJS-7 singular resolution
//   - multi-entry list resolves all selections in argv order
//   - empty list rejected
//   - env overrides applied once, restored once, regardless of error path
//   - getPrimaryGatewayRuntime returns the first entry, throws on empty

const opencodeResolver: RuntimeCommandResolver = {
  which(command) {
    if (command === "opencode") return "/usr/local/bin/opencode";
    if (command === "gemini") return "/usr/local/bin/gemini";
    return undefined;
  },
  async fileExists() {
    return false;
  },
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "agents-js-resolve-runtimes-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AJS_RUNTIME_LOG_LEVEL;
  delete process.env.AJS_DEFAULT_MODEL;
});

const curatedSelection = (runtime: "opencode" | "gemini"): GatewayRuntimeSelection => ({
  kind: "curated",
  runtime,
});

describe("resolveAndApplyGatewayRuntimes (plural)", () => {
  test("single-entry list resolves to a single-runtime array (back-compat)", async () => {
    const runtimes = await resolveAndApplyGatewayRuntimes({
      selections: [curatedSelection("opencode")],
      envOverrides: {},
      resolver: opencodeResolver,
    });
    expect(runtimes).toHaveLength(1);
    expect(runtimes[0]?.definition.id).toBe("opencode");
  });

  test("multi-entry list resolves all selections in argv order", async () => {
    const runtimes = await resolveAndApplyGatewayRuntimes({
      selections: [curatedSelection("opencode"), curatedSelection("gemini")],
      envOverrides: {},
      resolver: opencodeResolver,
    });
    expect(runtimes).toHaveLength(2);
    expect(runtimes.map((r) => r.definition.id)).toEqual(["opencode", "gemini"]);
  });

  test("argv order is preserved across multi-entry resolution (gemini first vs opencode first)", async () => {
    const reversed = await resolveAndApplyGatewayRuntimes({
      selections: [curatedSelection("gemini"), curatedSelection("opencode")],
      envOverrides: {},
      resolver: opencodeResolver,
    });
    expect(reversed.map((r) => r.definition.id)).toEqual(["gemini", "opencode"]);
  });

  test("empty selections list throws", async () => {
    await expect(
      resolveAndApplyGatewayRuntimes({
        selections: [],
        envOverrides: {},
        resolver: opencodeResolver,
      }),
    ).rejects.toThrow(/empty selection list/i);
  });

  test("env overrides are restored after successful multi-runtime resolution", async () => {
    const before = process.env.AJS_RUNTIME_LOG_LEVEL;
    await resolveAndApplyGatewayRuntimes({
      selections: [curatedSelection("opencode"), curatedSelection("gemini")],
      envOverrides: { runtimeLogLevel: "debug" },
      resolver: opencodeResolver,
    });
    expect(process.env.AJS_RUNTIME_LOG_LEVEL).toBe(before);
  });

  test("env overrides are restored even when a later selection fails to resolve", async () => {
    const before = process.env.AJS_RUNTIME_LOG_LEVEL;
    const partialResolver: RuntimeCommandResolver = {
      which(command) {
        if (command === "opencode") return "/usr/local/bin/opencode";
        return undefined;
      },
      async fileExists() {
        return false;
      },
    };
    await expect(
      resolveAndApplyGatewayRuntimes({
        selections: [curatedSelection("opencode"), { kind: "custom", command: "nonexistent-cmd" }],
        envOverrides: { runtimeLogLevel: "debug" },
        resolver: partialResolver,
      }),
    ).rejects.toThrow();
    expect(process.env.AJS_RUNTIME_LOG_LEVEL).toBe(before);
  });
});

describe("getPrimaryGatewayRuntime", () => {
  test("returns the first runtime from a non-empty list", () => {
    const fakeRuntimes = [
      { definition: { id: "opencode" } } as ResolvedGatewayRuntime,
      { definition: { id: "gemini" } } as ResolvedGatewayRuntime,
    ];
    expect(getPrimaryGatewayRuntime(fakeRuntimes).definition.id).toBe("opencode");
  });

  test("throws on empty list — empty fleet has no meaning", () => {
    expect(() => getPrimaryGatewayRuntime([])).toThrow(/empty runtimes list/i);
  });
});
