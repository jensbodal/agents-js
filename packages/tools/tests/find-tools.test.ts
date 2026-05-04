import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { registerBuiltins } from "../src/builtins.ts";
import { findTools } from "../src/find-tools.ts";
import { createRegistry, defaultRegistry } from "../src/registry.ts";
import type { ToolDefinition } from "../src/types.ts";

// `defaultRegistry` is a module-level singleton shared with every other test
// file in the suite. Calling `registerBuiltins()` at module load (the prior
// pattern) mutated that singleton before any `beforeAll` hook fired, leaking
// builtin tools across files in OS-dependent enumeration order. Snapshot
// the pre-test state here, register builtins for our tests, then restore on
// teardown so a future test asserting on registry isolation isn't broken
// by load-order side effects.
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

describe("findTools default registry", () => {
  test("returns searchDocs for hub-search-intent queries (self-hosting proof)", async () => {
    const hits = await findTools("search hub for ACP schema notes");
    const names = hits.map((t) => t.name);
    expect(names).toContain("searchDocs");
  });

  test("returns searchMemories for memory-intent queries (self-hosting proof)", async () => {
    const hits = await findTools("search agent memories for prior rules");
    const names = hits.map((t) => t.name);
    expect(names).toContain("searchMemories");
  });

  test("default limit is 3 or fewer", async () => {
    const hits = await findTools("search docs memories hub agent");
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});

describe("findTools with custom registry", () => {
  test("returns only tools from provided registry", async () => {
    const registry = createRegistry();
    const custom: ToolDefinition = {
      name: "myCustom",
      description: "does custom things",
      keywords: ["custom", "thing"],
      invoke: async () => ({ ok: true }),
    };
    registry.register(custom);

    const hits = await findTools("custom thing", { registry });
    expect(hits.map((t) => t.name)).toEqual(["myCustom"]);
  });

  test("respects explicit limit", async () => {
    const registry = createRegistry();
    for (const n of ["a", "b", "c", "d", "e"]) {
      registry.register({
        name: n,
        description: `tool shared-kw variant ${n}`,
        keywords: ["shared-kw"],
        invoke: async () => ({}),
      });
    }
    const hits = await findTools("shared-kw", { registry, limit: 2 });
    expect(hits.length).toBe(2);
  });

  test("returned tools are invokable", async () => {
    const registry = createRegistry();
    registry.register({
      name: "pingTool",
      description: "returns pong",
      keywords: ["ping"],
      invoke: async () => "pong",
    });
    const hits = await findTools("ping", { registry });
    expect(hits.length).toBe(1);
    const result = await hits[0]?.invoke({});
    expect(result).toBe("pong");
  });
});
