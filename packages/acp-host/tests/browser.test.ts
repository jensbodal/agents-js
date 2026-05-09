import { describe, expect, test } from "bun:test";
import * as browserSurface from "../src/browser.ts";

// The browser entry exists explicitly to keep Node-only deps (fs, child_process,
// MCP wiring) out of browser bundles. The src/browser.ts docblock spells this
// out: keep the entry minimal, never reach for ./index.ts. This test guards
// against accidental broadening of the browser surface.

const EXPECTED_BROWSER_EXPORTS = [
  "DEFAULT_AGENT_CONFIG",
  "DEV_AGENT_CONFIG",
  "Logger",
  "collectToolCallStats",
  "deriveWorkflowSurfaceState",
  "describeWorkflowError",
  "formatToolCallStatus",
  "getTrailingToolBlockStats",
  "summarizeToolGroup",
] as const;

describe("browser entry", () => {
  test("exports exactly the intentionally-narrow surface", () => {
    expect(Object.keys(browserSurface).sort()).toEqual([...EXPECTED_BROWSER_EXPORTS].sort());
  });

  test("does not re-export Node-only host primitives (guard against accidental broadening)", () => {
    // Symbols that the main entry exports and the browser entry intentionally
    // does NOT — if any leak in, src/index.ts has been pulled in transitively
    // and the browser bundle is no longer browser-safe.
    const indexOnlySymbols = [
      "ACPSessionController",
      "TerminalManager",
      "PermissionEngine",
      "PermissionStore",
      "CapabilityCache",
      "createNodeFileAdapters",
      "buildMinimalEnv",
      "resolveHostEnvPolicy",
      "buildForbiddenEnvKeys",
    ];
    for (const name of indexOnlySymbols) {
      expect((browserSurface as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});
