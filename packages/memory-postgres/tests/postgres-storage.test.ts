import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { MemoryRecord } from "@agents-js/memory";
import { LocalMemoryProvider } from "@agents-js/memory-local";
import { PostgresStorage } from "../src/postgres-storage.ts";

const POSTGRES_URL = process.env.POSTGRES_TEST_URL;
const SUITE_SCHEMA = `agents_js_memory_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const skip = !POSTGRES_URL;
const maybeDescribe = skip ? describe.skip : describe;

if (skip) {
  // eslint-disable-next-line no-console
  console.log(
    "[postgres-storage.test] POSTGRES_TEST_URL not set; skipping integration tests. " +
      "Set POSTGRES_TEST_URL=postgres://user:pass@host:port/db to enable.",
  );
}

maybeDescribe("PostgresStorage integration", () => {
  let storage: PostgresStorage;
  let provider: LocalMemoryProvider;

  beforeAll(async () => {
    if (POSTGRES_URL === undefined) {
      throw new Error("POSTGRES_TEST_URL must be set for this integration suite");
    }
    storage = new PostgresStorage({
      connectionString: POSTGRES_URL,
      schemaName: SUITE_SCHEMA,
    });
    provider = new LocalMemoryProvider({ storage });
  });

  afterAll(async () => {
    if (storage) {
      try {
        await storage.__dangerousDropTable();
      } catch {
        // tearDown best-effort
      }
      await storage.close();
    }
  });

  it("save → get (substrate-read primitive) round-trips a record", async () => {
    const actor = { kind: "agent" as const, actorId: "test-agent-1" };
    const saved = await provider.saveMemory(actor, {
      scope: { kind: "global" },
      type: "feedback",
      content: "postgres save-get smoke",
    });

    const fetched = await provider.get(saved.id);
    expect(fetched).not.toBeNull();
    if (fetched === null) throw new Error("get returned null after save");
    expect(fetched.id).toBe(saved.id);
    expect(fetched.content).toBe("postgres save-get smoke");
    expect(fetched.scope).toEqual({ kind: "global" });
    expect(fetched.type).toBe("feedback");
  });

  it("update → get reflects bumped revision + new content", async () => {
    const actor = { kind: "agent" as const, actorId: "test-agent-2" };
    const created = await provider.saveMemory(actor, {
      scope: { kind: "agent", agentId: "demo" },
      type: "user",
      content: "v1",
    });
    const updated = await provider.updateMemory(actor, { id: created.id, content: "v2" });
    const fetched = await provider.get(created.id);
    if (fetched === null) throw new Error("get returned null after update");
    expect(fetched.content).toBe("v2");
    expect(fetched.revision).toBe(updated.revision);
  });

  it("delete → get returns null", async () => {
    const actor = { kind: "agent" as const, actorId: "test-agent-3" };
    const created = await provider.saveMemory(actor, {
      scope: { kind: "global" },
      type: "user",
      content: "to-delete",
    });
    await provider.deleteMemory(actor, { id: created.id });
    expect(await provider.get(created.id)).toBeNull();
  });

  it("listByScope paginates with cursor; terminal cursor is null", async () => {
    const actor = { kind: "agent" as const, actorId: "test-agent-list" };
    const scope = { kind: "agent" as const, agentId: "list-test" };
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await provider.saveMemory(actor, {
        scope,
        type: "user",
        content: `item-${i}`,
      });
      ids.push(r.id);
    }

    const page1 = await provider.listByScope(scope, null, 3);
    expect(page1.records).toHaveLength(3);
    expect(page1.cursor).not.toBeNull();

    const page2 = await provider.listByScope(scope, page1.cursor, 3);
    expect(page2.records).toHaveLength(3);
    expect(page2.cursor).not.toBeNull();

    const page3 = await provider.listByScope(scope, page2.cursor, 3);
    expect(page3.records).toHaveLength(1);
    expect(page3.cursor).toBeNull();

    // No duplicates across pages
    const allReturnedIds = [
      ...page1.records.map((r: MemoryRecord) => r.id),
      ...page2.records.map((r: MemoryRecord) => r.id),
      ...page3.records.map((r: MemoryRecord) => r.id),
    ];
    expect(new Set(allReturnedIds).size).toBe(allReturnedIds.length);
  });

  it("listByScope filters strictly by scope (other-scope records excluded)", async () => {
    const actor = { kind: "agent" as const, actorId: "test-agent-filter" };
    const scopeA = { kind: "agent" as const, agentId: "filter-A" };
    const scopeB = { kind: "agent" as const, agentId: "filter-B" };
    await provider.saveMemory(actor, { scope: scopeA, type: "user", content: "A1" });
    await provider.saveMemory(actor, { scope: scopeA, type: "user", content: "A2" });
    await provider.saveMemory(actor, { scope: scopeB, type: "user", content: "B1" });

    const pageA = await provider.listByScope(scopeA, null, 10);
    expect(pageA.records.length).toBeGreaterThanOrEqual(2);
    for (const r of pageA.records) {
      expect(r.scope).toEqual(scopeA);
    }
    expect(pageA.records.every((r: MemoryRecord) => r.content !== "B1")).toBe(true);
  });

  it("idempotency: same (creator,key) returns prior record", async () => {
    const actor = { kind: "agent" as const, actorId: "test-agent-idem" };
    const first = await provider.saveMemory(actor, {
      scope: { kind: "global" },
      type: "user",
      content: "first",
      idempotencyKey: "shared-key",
    });
    const second = await provider.saveMemory(actor, {
      scope: { kind: "global" },
      type: "user",
      content: "should-be-ignored",
      idempotencyKey: "shared-key",
    });
    expect(second.id).toBe(first.id);
    expect(second.content).toBe("first");
  });

  it("get(unknown-id) returns null", async () => {
    expect(await provider.get("does-not-exist-id-xyz")).toBeNull();
  });
});
