import { describe, expect, test } from "bun:test";
import { parseArgv } from "../src/argv-parser.ts";
import { type HarnessesArg, harnessesArg } from "../src/shared-arg-specs.ts";

// `harnessesArg()` provides the multi-value harness-selection fragment
// used by `agents-js serve` (and any future gateway-process binaries).
// `--harness` is REPEATABLE; `--harnesses` is COMMA-SEPARATED. Both
// populate the same `harnesses` array in argv order. AJS-7 PR1 ships
// the data structure; PR2 fans out to multi-controller behavior.

interface TestArgs extends HarnessesArg {
  help?: boolean;
}

function parse(argv: string[]): TestArgs {
  return parseArgv<TestArgs>(argv, harnessesArg<TestArgs>(), { subcommandName: "test" });
}

describe("harnessesArg — single-harness back-compat", () => {
  test("`--harness opencode` alone produces a single-entry list", () => {
    const args = parse(["--harness", "opencode"]);
    expect(args.harnesses).toEqual(["opencode"]);
  });

  test("`--harnesses opencode` alone (single id via plural flag) also produces a single-entry list", () => {
    const args = parse(["--harnesses", "opencode"]);
    expect(args.harnesses).toEqual(["opencode"]);
  });

  test("no flag passed leaves `harnesses` undefined (interactive-wizard hook)", () => {
    const args = parse([]);
    expect(args.harnesses).toBeUndefined();
  });
});

describe("harnessesArg — multi-value forms", () => {
  test("`--harness` repeated appends to the list in argv order", () => {
    const args = parse(["--harness", "opencode", "--harness", "gemini"]);
    expect(args.harnesses).toEqual(["opencode", "gemini"]);
  });

  test("`--harnesses` with comma-separated value splits into ordered entries", () => {
    const args = parse(["--harnesses", "opencode,gemini,claude"]);
    expect(args.harnesses).toEqual(["opencode", "gemini", "claude"]);
  });

  test("mixed forms (`--harness x --harnesses y,z`) preserve argv order", () => {
    const args = parse(["--harness", "x", "--harnesses", "y,z"]);
    expect(args.harnesses).toEqual(["x", "y", "z"]);
  });

  test("mixed forms with `--harnesses` first preserve argv order", () => {
    const args = parse(["--harnesses", "a,b", "--harness", "c", "--harnesses", "d"]);
    expect(args.harnesses).toEqual(["a", "b", "c", "d"]);
  });
});

describe("harnessesArg — input hygiene", () => {
  test("`--harnesses` trims whitespace around comma-separated entries", () => {
    const args = parse(["--harnesses", " opencode , gemini "]);
    expect(args.harnesses).toEqual(["opencode", "gemini"]);
  });

  test("`--harnesses` filters empty entries from doubled commas", () => {
    const args = parse(["--harnesses", "opencode,,gemini,,"]);
    expect(args.harnesses).toEqual(["opencode", "gemini"]);
  });

  test("repeated identical ids are preserved (not deduped) — operator intent is recorded", () => {
    const args = parse(["--harness", "opencode", "--harnesses", "opencode,gemini"]);
    expect(args.harnesses).toEqual(["opencode", "opencode", "gemini"]);
  });
});

describe("harnessesArg — primary semantics", () => {
  test("first listed id is the primary (`harnesses[0]`) regardless of form", () => {
    expect(parse(["--harness", "opencode", "--harness", "gemini"]).harnesses?.[0]).toBe("opencode");
    expect(parse(["--harnesses", "gemini,opencode"]).harnesses?.[0]).toBe("gemini");
    expect(parse(["--harnesses", "opencode", "--harness", "gemini"]).harnesses?.[0]).toBe(
      "opencode",
    );
  });
});
