import { describe, expect, test } from "bun:test";
import * as browserSurface from "../src/browser.ts";

// browser.ts exists to keep node:fs (memory primitives) out of browser bundles.
// Its docblock spells out the contract: findTools + registry + router-pure
// helpers, no I/O. Guard against accidental broadening.

const EXPECTED_BROWSER_EXPORTS = [
  "createRegistry",
  "defaultRegistry",
  "findTools",
  "routeFetchContext",
  "scoreSnippet",
  "scoreTool",
  "tokenize",
] as const;

describe("browser entry", () => {
  test("exports exactly the intentionally-narrow surface", () => {
    expect(Object.keys(browserSurface).sort()).toEqual([...EXPECTED_BROWSER_EXPORTS].sort());
  });

  test("does not re-export Node-only symbols (fetchContext, searchMemories, searchDocs, spawnAgent)", () => {
    const indexOnlySymbols = [
      "fetchContext",
      "searchMemories",
      "searchDocs",
      "spawnAgent",
      "registerBuiltins",
    ];
    for (const name of indexOnlySymbols) {
      expect((browserSurface as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
