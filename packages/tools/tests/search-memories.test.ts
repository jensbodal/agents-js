import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchMemories } from "../src/primitives/search-memories.ts";

describe("searchMemories", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tools-mem-"));
    mkdirSync(join(root, ".agents", "alpha"), { recursive: true });
    mkdirSync(join(root, ".agents", "beta", "nested"), { recursive: true });
    writeFileSync(
      join(root, ".agents", "alpha", "notes.md"),
      "alpha agent prior session decision about caching strategy\nunrelated line\n",
    );
    writeFileSync(
      join(root, ".agents", "beta", "nested", "deep.md"),
      "beta remembered rule: never push to main without review\n",
    );
    writeFileSync(join(root, ".agents", "alpha", "ignored.txt"), "not markdown");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("returns snippets with full 5-field provenance", async () => {
    const fixedNow = new Date("2026-04-21T12:00:00.000Z");
    const r = await searchMemories({
      workspaceRoot: root,
      query: "caching strategy",
      now: () => fixedNow,
    });
    expect(r.snippets.length).toBeGreaterThan(0);
    expect(r.sources.length).toBeGreaterThan(0);
    for (const src of r.sources) {
      expect(src.source_type).toBe("hub-file");
      expect(typeof src.source_ref).toBe("string");
      expect(src.source_ref.length).toBeGreaterThan(0);
      expect(typeof src.observed_at).toBe("string");
      expect(src.retrieved_at).toBe(fixedNow.toISOString());
      expect(["responsible", "supporting"]).toContain(src.confidence);
    }
  });

  test("snippet source_index is valid", async () => {
    const r = await searchMemories({ workspaceRoot: root, query: "rule" });
    for (const s of r.snippets) {
      expect(s.source_index).toBeGreaterThanOrEqual(0);
      expect(s.source_index).toBeLessThan(r.sources.length);
    }
  });

  test("honors limit", async () => {
    const r = await searchMemories({ workspaceRoot: root, query: "rule caching", limit: 1 });
    expect(r.snippets.length).toBeLessThanOrEqual(1);
  });

  test("ignores non-markdown files", async () => {
    const r = await searchMemories({ workspaceRoot: root, query: "not markdown" });
    // none of the returned sources should be the ignored.txt file
    for (const s of r.sources) {
      expect(s.source_ref.endsWith(".txt")).toBe(false);
    }
  });

  test("returns empty result when .agents/ is absent", async () => {
    const empty = mkdtempSync(join(tmpdir(), "tools-mem-empty-"));
    try {
      const r = await searchMemories({ workspaceRoot: empty, query: "anything" });
      expect(r.snippets).toEqual([]);
      expect(r.sources).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
