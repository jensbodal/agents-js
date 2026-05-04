import { describe, expect, test } from "bun:test";
import * as browserSurface from "../src/browser.ts";

const EXPECTED_BROWSER_EXPORTS = [
  "classifyOperation",
  "createPermissionRule",
  "extractResourceScope",
  "generateScopeCandidates",
] as const;

describe("browser entry", () => {
  test("exports exactly the intentionally-narrow surface", () => {
    expect(Object.keys(browserSurface).sort()).toEqual([...EXPECTED_BROWSER_EXPORTS].sort());
  });

  test("each exported symbol is callable", () => {
    for (const name of EXPECTED_BROWSER_EXPORTS) {
      expect(typeof (browserSurface as Record<string, unknown>)[name]).toBe("function");
    }
  });

  test("does not re-export the full index surface (guard against accidental broadening)", () => {
    // A handful of symbols that the main entry exports and the browser entry
    // intentionally does not — if any of these leak, the browser surface has
    // grown without the deliberate review the file's docblock demands.
    const indexOnlySymbols = [
      "evaluatePermissionRules",
      "validateTerminalRequest",
      "evaluateWriteGate",
      "policyError",
      "validationError",
      "isWithinWorkspace",
    ];
    for (const name of indexOnlySymbols) {
      expect((browserSurface as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
