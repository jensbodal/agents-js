import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchContext } from "../src/fetch-context.ts";

describe("fetchContext", () => {
  let workspaceRoot: string;
  let hubRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "tools-fc-ws-"));
    hubRoot = mkdtempSync(join(tmpdir(), "tools-fc-hub-"));

    mkdirSync(join(workspaceRoot, ".agents", "planner"), { recursive: true });
    writeFileSync(
      join(workspaceRoot, ".agents", "planner", "memory.md"),
      "remembered rule: ask before committing changes\n",
    );

    writeFileSync(
      join(hubRoot, "guide.md"),
      "how to use fetchContext: call with a query and read the snippets\n",
    );
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(hubRoot, { recursive: true, force: true });
  });

  test("returns merged result with valid provenance on both sides", async () => {
    const fixedNow = new Date("2026-04-21T14:00:00.000Z");
    const r = await fetchContext("rule and guide", {
      workspaceRoot,
      hubRoot,
      hint: "both",
      now: () => fixedNow,
    });
    expect(r.snippets.length).toBeGreaterThan(0);
    for (const src of r.sources) {
      // 5-field provenance invariant
      expect(src.source_type).toBeDefined();
      expect(typeof src.source_ref).toBe("string");
      expect(typeof src.observed_at).toBe("string");
      expect(src.retrieved_at).toBe(fixedNow.toISOString());
      expect(["responsible", "supporting"]).toContain(src.confidence);
    }
  });

  test("every snippet source_index maps to a returned source", async () => {
    const r = await fetchContext("rule guide", { workspaceRoot, hubRoot });
    for (const s of r.snippets) {
      expect(s.source_index).toBeGreaterThanOrEqual(0);
      expect(s.source_index).toBeLessThan(r.sources.length);
      const src = r.sources[s.source_index];
      expect(src).toBeDefined();
    }
  });

  test("snippets returned are sorted by score descending", async () => {
    const r = await fetchContext("rule guide fetchContext", { workspaceRoot, hubRoot });
    for (let i = 1; i < r.snippets.length; i += 1) {
      expect(r.snippets[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(r.snippets[i]?.score ?? 0);
    }
  });

  test("honors limit by truncating merged snippets", async () => {
    // seed multiple matches to ensure > 2 candidates across both primitives
    mkdirSync(join(workspaceRoot, ".agents", "other"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".agents", "other", "x.md"), "rule guide foo\n");
    writeFileSync(join(hubRoot, "a.md"), "rule guide one\n");
    writeFileSync(join(hubRoot, "b.md"), "rule guide two\n");

    const r = await fetchContext("rule guide", {
      workspaceRoot,
      hubRoot,
      limit: 2,
    });
    expect(r.snippets.length).toBeLessThanOrEqual(2);
  });

  test("explicit prefer-memories hint still returns docs when primitives find hits", async () => {
    // Router runs both primitives in all cases; the hint is just a bias. We
    // just verify the result is well-formed under an explicit hint.
    const r = await fetchContext("rule", {
      workspaceRoot,
      hubRoot,
      hint: "prefer-memories",
    });
    expect(Array.isArray(r.snippets)).toBe(true);
    expect(Array.isArray(r.sources)).toBe(true);
  });

  test("no orphan sources in returned result", async () => {
    mkdirSync(join(workspaceRoot, ".agents", "x"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".agents", "x", "a.md"), "rule A\n");
    writeFileSync(join(workspaceRoot, ".agents", "x", "b.md"), "rule B\n");
    writeFileSync(join(hubRoot, "c.md"), "rule C\n");
    writeFileSync(join(hubRoot, "d.md"), "rule D\n");

    const r = await fetchContext("rule", { workspaceRoot, hubRoot, limit: 2 });
    const referenced = new Set(r.snippets.map((s) => s.source_index));
    expect(referenced.size).toBe(r.sources.length);
  });
});
