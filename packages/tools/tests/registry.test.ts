import { describe, expect, test } from "bun:test";
import { createRegistry } from "../src/registry.ts";
import type { ToolDefinition } from "../src/types.ts";

function mkTool(name: string, description: string, keywords: string[] = []): ToolDefinition {
  return { name, description, keywords, invoke: async () => ({ ok: true }) };
}

describe("createRegistry", () => {
  test("register + list round-trips tools", () => {
    const r = createRegistry();
    const a = mkTool("alpha", "first tool");
    const b = mkTool("beta", "second tool");
    r.register(a);
    r.register(b);
    const list = r.list();
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.name).sort()).toEqual(["alpha", "beta"]);
  });

  test("register with duplicate name overwrites", () => {
    const r = createRegistry();
    r.register(mkTool("x", "original"));
    r.register(mkTool("x", "replacement"));
    const list = r.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.description).toBe("replacement");
  });

  test("register rejects empty name", () => {
    const r = createRegistry();
    expect(() => r.register(mkTool("", "bad"))).toThrow();
    expect(() => r.register(mkTool("   ", "bad"))).toThrow();
  });

  test("find returns up to limit sorted by score desc", () => {
    const r = createRegistry();
    r.register(mkTool("searchDocs", "search hub docs", ["hub", "docs"]));
    r.register(mkTool("searchMemories", "search agent memories", ["memory", "agent"]));
    r.register(mkTool("unrelated", "does other things", ["xyz"]));
    const hits = r.find("search hub docs", 2);
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits[0]?.name).toBe("searchDocs");
  });

  test("find filters out zero-score tools", () => {
    const r = createRegistry();
    r.register(mkTool("alpha", "does alpha things"));
    r.register(mkTool("beta", "does beta things"));
    const hits = r.find("alpha");
    expect(hits.map((t) => t.name)).toEqual(["alpha"]);
  });

  test("find returns [] on no-matches", () => {
    const r = createRegistry();
    r.register(mkTool("alpha", "does alpha things"));
    expect(r.find("zzz unrelated")).toEqual([]);
  });

  test("find default limit is 3", () => {
    const r = createRegistry();
    for (const n of ["a", "b", "c", "d", "e"]) {
      r.register(mkTool(n, `matchtoken for ${n}`, ["matchtoken"]));
    }
    const hits = r.find("matchtoken");
    expect(hits.length).toBe(3);
  });
});
