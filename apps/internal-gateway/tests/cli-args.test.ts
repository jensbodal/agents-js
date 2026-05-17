import { describe, expect, test } from "bun:test";
import { parseCliArgs } from "../cli-args.ts";

/**
 * The internal-gateway exposes its own argv parser (it does not share
 * the published CLI's table-driven parser). The release-readiness work
 * adds `--trust-workspace` here so the gate that controls
 * `.agents-js/permission-rules.json` loading has a CLI surface.
 *
 * The trust gate is a security boundary: an ambiguous truthy coercion
 * (e.g. `=1`, `=yes`) must NOT cross it — only the literal string
 * `"true"` or the explicit flag.
 */
describe("parseCliArgs — workspace trust gate", () => {
  test("default — trustWorkspace is false when flag absent and env unset", () => {
    expect(parseCliArgs([], {}).trustWorkspace).toBe(false);
  });

  test("--trust-workspace flag enables trust", () => {
    expect(parseCliArgs(["--trust-workspace"], {}).trustWorkspace).toBe(true);
  });

  test("AGENTS_JS_TRUST_WORKSPACE=true env enables trust", () => {
    expect(parseCliArgs([], { AGENTS_JS_TRUST_WORKSPACE: "true" }).trustWorkspace).toBe(true);
  });

  test("env values other than the literal 'true' do NOT enable trust", () => {
    for (const value of ["1", "yes", "TRUE", "True", "on", " true ", ""]) {
      expect(parseCliArgs([], { AGENTS_JS_TRUST_WORKSPACE: value }).trustWorkspace).toBe(false);
    }
  });

  test("flag wins over env when both are set", () => {
    expect(
      parseCliArgs(["--trust-workspace"], { AGENTS_JS_TRUST_WORKSPACE: "false" }).trustWorkspace,
    ).toBe(true);
  });

  test("does not break existing flags — workspace and permission-mode still parse", () => {
    const args = parseCliArgs(
      ["--trust-workspace", "--workspace", "/tmp/ws", "--permission-mode", "yolo"],
      {},
    );
    expect(args.workspace).toBe("/tmp/ws");
    expect(args.permissionMode).toBe("yolo");
    expect(args.trustWorkspace).toBe(true);
  });
});

describe("parseCliArgs — registry sync gate", () => {
  test("default — registrySync is false when flag absent and env unset", () => {
    expect(parseCliArgs([], {}).registrySync).toBe(false);
  });

  test("--registry-sync flag enables sync", () => {
    expect(parseCliArgs(["--registry-sync"], {}).registrySync).toBe(true);
  });

  test("AGENTS_JS_REGISTRY_SYNC=true env enables sync", () => {
    expect(parseCliArgs([], { AGENTS_JS_REGISTRY_SYNC: "true" }).registrySync).toBe(true);
  });

  test("env values other than the literal 'true' do NOT enable sync", () => {
    for (const value of ["1", "yes", "TRUE", "True", "on", " true ", ""]) {
      expect(parseCliArgs([], { AGENTS_JS_REGISTRY_SYNC: value }).registrySync).toBe(false);
    }
  });

  test("flag wins over env when both are set", () => {
    expect(
      parseCliArgs(["--registry-sync"], { AGENTS_JS_REGISTRY_SYNC: "false" }).registrySync,
    ).toBe(true);
  });

  test("registrySync and trustWorkspace gates are independent", () => {
    const both = parseCliArgs(["--registry-sync", "--trust-workspace"], {});
    expect(both.registrySync).toBe(true);
    expect(both.trustWorkspace).toBe(true);

    const onlyRegistry = parseCliArgs(["--registry-sync"], {});
    expect(onlyRegistry.registrySync).toBe(true);
    expect(onlyRegistry.trustWorkspace).toBe(false);

    const onlyTrust = parseCliArgs(["--trust-workspace"], {});
    expect(onlyTrust.registrySync).toBe(false);
    expect(onlyTrust.trustWorkspace).toBe(true);
  });
});

/**
 * The internal-gateway accepts `--runtime <id>` (repeatable, single
 * value) AND `--runtimes <id1,id2>` (comma-separated). Both forms
 * populate `runtimeOverrides: readonly string[]` in argv order.
 * Index 0 is the primary routing target. Single-runtime invocations
 * (`--runtime opencode` alone) produce a 1-element array so
 * downstream consumers reading `runtimeOverrides[0]` get
 * byte-identical behavior to the original single-runtime form.
 */
describe("parseCliArgs — multi-runtime selection", () => {
  test("default — runtimeOverrides is empty when no runtime flag present", () => {
    expect(parseCliArgs([], {}).runtimeOverrides).toEqual([]);
  });

  test("single `--runtime opencode` yields a 1-element list (back-compat)", () => {
    expect(parseCliArgs(["--runtime", "opencode"], {}).runtimeOverrides).toEqual(["opencode"]);
  });

  test("repeated `--runtime` flag pushes in argv order", () => {
    expect(
      parseCliArgs(["--runtime", "opencode", "--runtime", "gemini"], {}).runtimeOverrides,
    ).toEqual(["opencode", "gemini"]);
  });

  test("`--runtimes a,b,c` splits on commas and trims whitespace", () => {
    expect(parseCliArgs(["--runtimes", " opencode , gemini ,codex"], {}).runtimeOverrides).toEqual([
      "opencode",
      "gemini",
      "codex",
    ]);
  });

  test("mixed `--runtime` and `--runtimes` forms preserve argv order", () => {
    expect(
      parseCliArgs(["--runtimes", "a,b", "--runtime", "c", "--runtimes", "d,e"], {})
        .runtimeOverrides,
    ).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("`--runtimes` rejects an empty entry between commas", () => {
    expect(() => parseCliArgs(["--runtimes", "a,,b"], {})).toThrow(/empty entry/);
  });

  test("`--runtimes` rejects a value with only a comma", () => {
    expect(() => parseCliArgs(["--runtimes", ","], {})).toThrow(/empty entry/);
  });

  test("`--runtime` without a value throws", () => {
    expect(() => parseCliArgs(["--runtime"], {})).toThrow(/Missing value for "--runtime"/);
  });

  test("`--runtimes` without a value throws", () => {
    expect(() => parseCliArgs(["--runtimes"], {})).toThrow(/Missing value for "--runtimes"/);
  });
});
