import { describe, expect, test } from "bun:test";
import { DiscoveryIndex } from "../src/discovery.ts";

function makeIndex() {
  const idx = new DiscoveryIndex();
  idx.add({ name: "alpha", description: "Alpha agent — summarises text", source: "agent" });
  idx.add({ name: "beta", description: "Beta agent — file read helper", source: "agent" });
  idx.add({ name: "gamma", description: "Gamma agent — runs shell", source: "agent" });
  idx.add({
    name: "cross-review",
    description: "Multi-agent cross-review workflow skill",
    source: "skill",
  });
  idx.add({
    name: "filesystem-read",
    description: "Read a file from disk",
    source: "internal",
  });
  return idx;
}

describe("DiscoveryIndex", () => {
  test("substring match ranks name hits above description hits", () => {
    const idx = makeIndex();
    const results = idx.search("read");
    const names = results.map((r) => r.name);
    // filesystem-read matches by name and should come first; beta
    // matches by description ("file read helper") and should follow.
    expect(names).toEqual(["filesystem-read", "beta"]);
  });

  test("empty query returns the full sorted catalog", () => {
    const idx = makeIndex();
    const results = idx.search("");
    expect(results.map((r) => r.name)).toEqual([
      "alpha",
      "beta",
      "cross-review",
      "filesystem-read",
      "gamma",
    ]);
  });

  test("whitespace-only query is treated as empty", () => {
    const idx = makeIndex();
    expect(idx.search("   ").length).toBe(5);
  });

  test("match is case-insensitive", () => {
    const idx = makeIndex();
    const upper = idx.search("ALPHA");
    const lower = idx.search("alpha");
    expect(upper.map((r) => r.name)).toEqual(lower.map((r) => r.name));
    expect(upper[0]?.name).toBe("alpha");
  });

  test("limit caps results and is bounded to [1, 100]", () => {
    const idx = makeIndex();
    expect(idx.search("", { limit: 2 }).length).toBe(2);
    // limit < 1 is clamped up to 1
    expect(idx.search("", { limit: 0 }).length).toBe(1);
    // limit > 100 is clamped down to 100 (we only have 5 entries so no
    // ceiling hit, but the call must not throw)
    expect(idx.search("", { limit: 500 }).length).toBe(5);
  });

  test("no match returns empty array", () => {
    const idx = makeIndex();
    expect(idx.search("nothing-here-at-all")).toEqual([]);
  });

  test("skills are discoverable alongside agents", () => {
    const idx = makeIndex();
    const results = idx.search("cross");
    expect(results).toHaveLength(1);
    expect(results[0]?.source).toBe("skill");
  });

  test("add replaces an existing entry with the same name", () => {
    const idx = new DiscoveryIndex();
    idx.add({ name: "x", description: "v1", source: "agent" });
    idx.add({ name: "x", description: "v2", source: "agent" });
    expect(idx.size).toBe(1);
    expect(idx.get("x")?.description).toBe("v2");
  });

  test("remove + has reflect current membership", () => {
    const idx = makeIndex();
    expect(idx.has("alpha")).toBe(true);
    expect(idx.remove("alpha")).toBe(true);
    expect(idx.has("alpha")).toBe(false);
    expect(idx.remove("alpha")).toBe(false);
  });

  test("clear drops every entry", () => {
    const idx = makeIndex();
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.list()).toEqual([]);
  });
});
