import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultRegistry, registerBuiltins, type ToolDefinition } from "@agents-js/tools";
import { RD_GATE_IDS, runReadinessGates } from "../src/readiness-gates.ts";

// `defaultRegistry` is a module-level singleton shared with every other test
// file in the suite (across packages, since the registry lives in
// `@agents-js/tools`). The trial-agent bin calls `registerBuiltins` at its
// own bootstrap; in-process tests must do it themselves but should NOT
// pollute the singleton across files. Snapshot the pre-test state, register
// builtins for our tests, then restore on teardown.
let preTestSnapshot: ToolDefinition[] = [];
beforeAll(() => {
  preTestSnapshot = defaultRegistry.list();
  registerBuiltins();
});
afterAll(() => {
  defaultRegistry.clear();
  for (const tool of preTestSnapshot) {
    defaultRegistry.register(tool);
  }
});

const FIXTURE_WS = path.resolve(import.meta.dir, "fixtures/workspace");
const FIXTURE_HUB = path.resolve(import.meta.dir, "fixtures/hub");

describe("runReadinessGates", () => {
  test("returns one result per declared gate id, in order", async () => {
    const report = await runReadinessGates({
      workspaceRoot: FIXTURE_WS,
      hubRoot: FIXTURE_HUB,
    });
    expect(report.results.map((r) => r.id)).toEqual([...RD_GATE_IDS]);
    expect(report.summary.passed + report.summary.failed + report.summary.deferred).toBe(
      report.results.length,
    );
  });

  test("Matrix and agent-msg gates are deferred (D follow-on)", async () => {
    const report = await runReadinessGates({
      workspaceRoot: FIXTURE_WS,
      hubRoot: FIXTURE_HUB,
    });
    const matrix = report.results.find((r) => r.id === "matrix-source-or-deferred");
    const agentMsg = report.results.find((r) => r.id === "agent-msg-source-or-deferred");
    expect(matrix?.outcome).toBe("deferred");
    expect(matrix?.detail).toContain("searchRoomHistory");
    expect(agentMsg?.outcome).toBe("deferred");
    expect(agentMsg?.detail).toContain("searchAgentMsg");
  });

  test("hub-vault gate passes when fixture has matching content", async () => {
    const report = await runReadinessGates({
      workspaceRoot: FIXTURE_WS,
      hubRoot: FIXTURE_HUB,
      probeQuery: "time estimates review",
    });
    const hub = report.results.find((r) => r.id === "hub-vault-source");
    expect(hub?.outcome).toBe("pass");
    expect(hub?.detail).toContain("/");
  });

  test("self-hosting gate passes — searchDocs at top of findTools result", async () => {
    const report = await runReadinessGates({
      workspaceRoot: FIXTURE_WS,
      hubRoot: FIXTURE_HUB,
    });
    const sh = report.results.find((r) => r.id === "find-tools-self-hosting");
    expect(sh?.outcome).toBe("pass");
  });

  test("narrow-result gate passes when 1-3 tools returned", async () => {
    const report = await runReadinessGates({
      workspaceRoot: FIXTURE_WS,
      hubRoot: FIXTURE_HUB,
    });
    const narrow = report.results.find((r) => r.id === "find-tools-narrow-result");
    expect(narrow?.outcome).toBe("pass");
  });

  test("three-line ergonomics gate passes — FetchContext result has documented shape", async () => {
    const report = await runReadinessGates({
      workspaceRoot: FIXTURE_WS,
      hubRoot: FIXTURE_HUB,
    });
    const ergo = report.results.find((r) => r.id === "fetch-context-three-line-ergonomics");
    expect(ergo?.outcome).toBe("pass");
  });
});

/**
 * `stale-source-confidence` gate uses a regex with word-boundary anchors:
 *   STALE_SOURCE_MARKER = /\bstale\b|\bdeprecated\b|\bsupersed/i
 *
 * The Phase 2 sweep originally swapped this for three `String.includes`
 * calls, which silently broadened false-positive surface (matching
 * "stalemate", "undeprecated", "asuperseded", "deprecation", etc.). The
 * follow-up commit `3b60ef1` restored the regex with named-const + comment.
 *
 * These tests pin the boundary behavior so a future "simplify" sweep
 * cannot re-broaden it without explicit signal. Each test builds a temp
 * hub vault with controlled markdown content, so the assertion explains
 * the rule rather than depending on existing fixture wording.
 */
describe("stale-source-confidence — word-boundary regression coverage", () => {
  // Three-token probe so search-docs scores the anchor line highly. The
  // anchor line below is positioned at index 1 of the markdown so the
  // surrounding-3-lines snippet (lines[bestIdx-1..bestIdx+2]) returned
  // from extractBestSnippet covers both the line above and the line below.
  const PROBE_QUERY = "responsibility check review";

  async function makeStaleSourceFixture(hubDoc: string): Promise<{
    hubRoot: string;
    wsRoot: string;
    cleanup: () => Promise<void>;
  }> {
    const root = await mkdtemp(path.join(tmpdir(), "stale-src-test-"));
    const hubRoot = path.join(root, "hub");
    const wsRoot = path.join(root, "workspace");
    await mkdir(hubRoot, { recursive: true });
    // Empty `.agents/<name>/` keeps search-memories quiet without
    // contributing snippets that could confound the gate.
    await mkdir(path.join(wsRoot, ".agents", "test-agent"), { recursive: true });
    await writeFile(path.join(hubRoot, "doc.md"), hubDoc);
    return { hubRoot, wsRoot, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  test("PASSes on false-positive substrings (stalemate/undeprecated/asuperseded/deprecation/stalest)", async () => {
    // Line 0 holds the would-be false positives; line 1 is the probe anchor
    // (highest-scoring line); line 2 is empty filler. The snippet returned
    // by search-docs covers all three lines, so STALE_SOURCE_MARKER will
    // see every substring on line 0 — and must match none of them.
    const fx = await makeStaleSourceFixture(
      [
        "Stalemate, undeprecated, asuperseded, deprecation, and stalest scenarios are not real markers.",
        "Probe-matching anchor for responsibility check review.",
        "",
      ].join("\n"),
    );
    try {
      const report = await runReadinessGates({
        workspaceRoot: fx.wsRoot,
        hubRoot: fx.hubRoot,
        probeQuery: PROBE_QUERY,
      });
      const gate = report.results.find((r) => r.id === "stale-source-confidence");
      expect(gate?.outcome).toBe("pass");
    } finally {
      await fx.cleanup();
    }
  });

  for (const marker of ["stale", "deprecated", "superseded"] as const) {
    test(`FAILs on true marker "${marker}" when surfaced from a responsible source`, async () => {
      const fx = await makeStaleSourceFixture(
        [
          "",
          `Probe-matching anchor for responsibility check review with ${marker} content noted here.`,
          "",
        ].join("\n"),
      );
      try {
        const report = await runReadinessGates({
          workspaceRoot: fx.wsRoot,
          hubRoot: fx.hubRoot,
          probeQuery: PROBE_QUERY,
        });
        const gate = report.results.find((r) => r.id === "stale-source-confidence");
        expect(gate?.outcome).toBe("fail");
      } finally {
        await fx.cleanup();
      }
    });
  }
});
