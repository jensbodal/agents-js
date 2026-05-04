import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchDocs } from "../src/primitives/search-docs.ts";

describe("searchDocs", () => {
  let hub: string;

  beforeEach(() => {
    hub = mkdtempSync(join(tmpdir(), "tools-docs-"));
    mkdirSync(join(hub, "plans"), { recursive: true });
    mkdirSync(join(hub, "node_modules", "deep"), { recursive: true });
    writeFileSync(join(hub, "README.md"), "welcome to the hub\nthe ACP schema lives here\n");
    writeFileSync(
      join(hub, "plans", "first-week.md"),
      "Shape 1 coordinator ships the FetchContext verb\nwith provenance\n",
    );
    // should be skipped by SKIP_DIR_NAMES
    writeFileSync(join(hub, "node_modules", "deep", "noise.md"), "acp schema in node modules");
  });

  afterEach(() => {
    rmSync(hub, { recursive: true, force: true });
  });

  test("returns ranked snippets with full provenance", async () => {
    const fixedNow = new Date("2026-04-21T13:00:00.000Z");
    const r = await searchDocs({ hubRoot: hub, query: "ACP schema", now: () => fixedNow });
    expect(r.snippets.length).toBeGreaterThan(0);
    expect(r.sources.length).toBeGreaterThan(0);
    for (const src of r.sources) {
      expect(src.source_type).toBe("hub-file");
      expect(src.source_ref.startsWith(hub)).toBe(true);
      expect(src.retrieved_at).toBe(fixedNow.toISOString());
      expect(["responsible", "supporting"]).toContain(src.confidence);
    }
  });

  test("skips node_modules and other ignored directories", async () => {
    const r = await searchDocs({ hubRoot: hub, query: "acp schema" });
    for (const src of r.sources) {
      expect(src.source_ref).not.toContain("node_modules");
    }
  });

  test("honors limit parameter", async () => {
    writeFileSync(join(hub, "a.md"), "foo bar baz");
    writeFileSync(join(hub, "b.md"), "foo bar qux");
    const r = await searchDocs({ hubRoot: hub, query: "foo bar", limit: 1 });
    expect(r.snippets.length).toBeLessThanOrEqual(1);
  });

  test("returns empty for non-existent hubRoot", async () => {
    const r = await searchDocs({
      hubRoot: "/definitely/not/a/real/path/xyzzy",
      query: "anything",
    });
    expect(r.snippets).toEqual([]);
    expect(r.sources).toEqual([]);
  });

  test("snippets rank higher scores first", async () => {
    writeFileSync(join(hub, "lowscore.md"), "provenance mentioned once\n");
    writeFileSync(join(hub, "highscore.md"), "provenance Shape coordinator verb\n");
    const r = await searchDocs({ hubRoot: hub, query: "provenance Shape coordinator" });
    if (r.snippets.length >= 2) {
      expect(r.snippets[0]?.score).toBeGreaterThanOrEqual(r.snippets[1]?.score ?? 0);
    }
  });
});
