import { describe, expect, test } from "bun:test";
import {
  createRuntimeSelectionFromArgs,
  createRuntimeSelectionsFromArgs,
} from "../src/shared-runtime-helpers.ts";

// Tests for the multi-runtime selection helper.
// `createRuntimeSelectionFromArgs` (singular) stays as-is for ACP-command
// and other single-harness CLI paths; `createRuntimeSelectionsFromArgs`
// (plural) accepts the `harnesses: string[]` shape that `serve` and
// internal-gateway CLI parsing produces.

describe("createRuntimeSelectionsFromArgs — single-harness back-compat", () => {
  test("returns undefined when no harness and no acpCommand supplied", () => {
    expect(createRuntimeSelectionsFromArgs({})).toBeUndefined();
  });

  test("legacy `harness` string lifts into a 1-element list", () => {
    const result = createRuntimeSelectionsFromArgs({ harness: "opencode" });
    expect(result).toEqual([{ kind: "curated", profile: undefined, runtime: "opencode" }]);
  });

  test("1-element `harnesses` array behaves identically to legacy `harness`", () => {
    const legacy = createRuntimeSelectionsFromArgs({ harness: "opencode" });
    const modern = createRuntimeSelectionsFromArgs({ harnesses: ["opencode"] });
    expect(modern).toEqual(legacy);
  });
});

describe("createRuntimeSelectionsFromArgs — multi-harness", () => {
  test("returns an ordered list with index 0 as primary", () => {
    const result = createRuntimeSelectionsFromArgs({
      harnesses: ["opencode", "gemini", "codex"],
    });
    expect(result?.length).toBe(3);
    expect(result?.[0]).toEqual({ kind: "curated", profile: undefined, runtime: "opencode" });
    expect(result?.[1]).toEqual({ kind: "curated", profile: undefined, runtime: "gemini" });
    expect(result?.[2]).toEqual({ kind: "curated", profile: undefined, runtime: "codex" });
  });

  test("preserves duplicate ids so the downstream validator can reject with precision", () => {
    const result = createRuntimeSelectionsFromArgs({ harnesses: ["opencode", "opencode"] });
    expect(result?.length).toBe(2);
    expect(result?.[0]?.kind).toBe("curated");
    expect(result?.[1]?.kind).toBe("curated");
  });

  test("threads `profile` through to every curated selection", () => {
    const result = createRuntimeSelectionsFromArgs({
      harnesses: ["opencode", "gemini"],
      profile: "developer",
    });
    expect(result?.[0]).toMatchObject({ kind: "curated", profile: "developer" });
    expect(result?.[1]).toMatchObject({ kind: "curated", profile: "developer" });
  });
});

describe("createRuntimeSelectionsFromArgs — input validation", () => {
  test("rejects passing both `harness` and a non-empty `harnesses` simultaneously", () => {
    expect(() =>
      createRuntimeSelectionsFromArgs({ harness: "opencode", harnesses: ["gemini"] }),
    ).toThrow(/Pass --harness or --harnesses, not both shapes simultaneously/);
  });

  test("accepts `harness` alongside an empty `harnesses` array (treats list as absent)", () => {
    const result = createRuntimeSelectionsFromArgs({ harness: "opencode", harnesses: [] });
    expect(result?.length).toBe(1);
    expect(result?.[0]).toMatchObject({ runtime: "opencode" });
  });

  test("rejects `--acp-command` with more than one harness id", () => {
    expect(() =>
      createRuntimeSelectionsFromArgs({
        acpCommand: "/usr/local/bin/my-acp",
        harnesses: ["custom", "opencode"],
      }),
    ).toThrow(/--acp-command is only valid with a single harness selection/);
  });

  test("accepts `--acp-command` with no harness selection (lifts into a 1-element custom list)", () => {
    const result = createRuntimeSelectionsFromArgs({
      acpCommand: "/usr/local/bin/my-acp",
    });
    expect(result?.length).toBe(1);
    expect(result?.[0]).toEqual({
      kind: "custom",
      command: "/usr/local/bin/my-acp",
      args: [],
      displayName: "Custom ACP Runtime",
      description: "Operator-selected custom ACP runtime.",
    });
  });

  test("accepts `--acp-command --harness custom` with --acp-args-json", () => {
    const result = createRuntimeSelectionsFromArgs({
      acpCommand: "/usr/local/bin/my-acp",
      harnesses: ["custom"],
      acpArgsJson: '["--flag","value"]',
    });
    expect(result?.length).toBe(1);
    expect(result?.[0]).toMatchObject({
      kind: "custom",
      command: "/usr/local/bin/my-acp",
      args: ["--flag", "value"],
    });
  });
});

describe("createRuntimeSelectionFromArgs (singular) — back-compat for single-harness callers", () => {
  test("still returns a single selection for ACP-command and bridge/send/registry callers", () => {
    const result = createRuntimeSelectionFromArgs({ harness: "opencode" });
    expect(result).toEqual({ kind: "curated", profile: undefined, runtime: "opencode" });
  });
});
