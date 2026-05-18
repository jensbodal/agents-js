import { MemoryAclError, type MemoryProvider, MemoryRevisionConflictError } from "./provider.ts";
import type { MemoryActor } from "./types.ts";

/**
 * Minimal structural shape we use from a test framework's `expect()`.
 * Each method returns `unknown` so the type is a supertype of bun /
 * vitest / jest's richer `Matchers<T>` — callers can pass `expect`
 * directly without `as never` casts. The two-overload form below
 * matches Bun's `Expect` interface (which exposes a `(actual?: never)`
 * overload alongside the value-taking overload).
 */
interface Expectation {
  toBe(other: unknown): unknown;
  toEqual(other: unknown): unknown;
  toBeDefined(): unknown;
  toBeGreaterThanOrEqual(other: number): unknown;
  toBeInstanceOf(ctor: new (...args: never[]) => unknown): unknown;
  rejects: { toBeInstanceOf(ctor: new (...args: never[]) => unknown): unknown };
}

interface ExpectFn {
  (value?: never): Expectation;
  (value: unknown): Expectation;
}

/**
 * Conformance harness arguments. Pass `describe`, `it`, and `expect`
 * directly from `bun:test` / `vitest` / `jest` — keeps the package
 * framework-agnostic via dependency injection.
 */
export interface ConformanceOptions {
  describe: (label: string, body: () => void) => void;
  it: (label: string, body: () => void | Promise<void>) => void;
  expect: ExpectFn;
  /** Factory called once per test to produce a fresh provider instance. */
  makeProvider: () => MemoryProvider;
}

export function createMockActor(overrides: Partial<MemoryActor> = {}): MemoryActor {
  return { kind: "agent", actorId: "test-actor", ...overrides };
}

/**
 * Drop-in conformance suite. As of v0.6.0 (ADR 0001), providers expose
 * substrate read primitives ({@link MemoryProvider.get},
 * {@link MemoryProvider.listByScope}). The harness uses `get` for
 * independent read verification of mutation outcomes — without this,
 * "save returned record but storage silently dropped it" failure modes
 * pass conformance. `listByScope` is also exercised as substrate primitive.
 */
export function runProviderConformanceTests(opts: ConformanceOptions): void {
  const { describe, it, expect, makeProvider } = opts;

  describe("MemoryProvider conformance — save/update/delete basics", () => {
    it("save returns a record with all required fields populated", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      const record = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "feedback",
        content: "be terse",
      });
      expect(record.id).toBeDefined();
      expect(record.scope).toEqual({ kind: "global" });
      expect(record.type).toBe("feedback");
      expect(record.content).toBe("be terse");
      expect(record.metadata).toEqual({});
      expect(record.createdAtMs).toBeDefined();
      expect(record.updatedAtMs).toBeGreaterThanOrEqual(record.createdAtMs);
    });

    it("save echoes scope unchanged", async () => {
      const provider = makeProvider();
      const scope = { kind: "agent" as const, agentId: "alice" };
      const record = await provider.saveMemory(createMockActor(), {
        scope,
        type: "user",
        content: "x",
      });
      expect(record.scope).toEqual(scope);
    });

    it("update modifies content + bumps updatedAtMs", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      const created = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "project",
        content: "v1",
      });
      const updated = await provider.updateMemory(actor, {
        id: created.id,
        content: "v2",
      });
      expect(updated.content).toBe("v2");
      expect(updated.updatedAtMs).toBeGreaterThanOrEqual(created.updatedAtMs);
      expect(updated.id).toBe(created.id);
    });

    it("returned record's mutable fields don't leak into provider state", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      const created = await provider.saveMemory(actor, {
        scope: { kind: "agent", agentId: "alice" },
        type: "user",
        content: "x",
        metadata: { tags: ["a"] },
      });
      // Mutate the returned record — provider state must not change.
      (created.metadata.tags as string[]).push("b");
      if (created.scope.kind === "agent") {
        created.scope.agentId = "mallory";
      }
      // Read back via a no-op update (no content, no metadata) — this
      // exercises the read path that does NOT do its own clone-on-write,
      // so any internal aliasing of the saved-input objects would show up.
      const refetched = await provider.updateMemory(actor, { id: created.id });
      expect(refetched.metadata).toEqual({ tags: ["a"] });
      expect(refetched.scope).toEqual({ kind: "agent", agentId: "alice" });
    });

    it("passing metadata={} replaces (not merges) existing metadata", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      const created = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "project",
        content: "x",
        metadata: { tags: ["a"] },
      });
      const updated = await provider.updateMemory(actor, { id: created.id, metadata: {} });
      expect(updated.metadata).toEqual({});
    });

    it("delete removes the record (subsequent update raises)", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      const created = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "reference",
        content: "x",
      });
      await provider.deleteMemory(actor, { id: created.id });
      await expect(
        provider.updateMemory(actor, { id: created.id, content: "y" }),
      ).rejects.toBeInstanceOf(Error);
    });
  });

  describe("MemoryProvider conformance — idempotency", () => {
    it("repeated save with same idempotencyKey returns the same id", async (): Promise<void> => {
      const provider = makeProvider();
      if (!provider.capabilities().idempotency) return;
      const actor = createMockActor();
      const a = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "learning",
        content: "x",
        idempotencyKey: "k1",
      });
      const b = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "learning",
        content: "x",
        idempotencyKey: "k1",
      });
      expect(b.id).toBe(a.id);
    });
  });

  describe("MemoryProvider conformance — revisions", () => {
    it("update with stale expectedRevision raises MemoryRevisionConflictError", async () => {
      const provider = makeProvider();
      if (!provider.capabilities().revisions) return;
      const actor = createMockActor();
      const created = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "project",
        content: "v1",
      });
      await provider.updateMemory(actor, { id: created.id, content: "v2" });
      await expect(
        provider.updateMemory(actor, {
          id: created.id,
          content: "v3",
          expectedRevision: created.revision,
        }),
      ).rejects.toBeInstanceOf(MemoryRevisionConflictError);
    });

    it("provider without revisions capability ignores expectedRevision (no throw)", async () => {
      const provider = makeProvider();
      if (provider.capabilities().revisions) return;
      const actor = createMockActor();
      const created = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "project",
        content: "v1",
      });
      // Stale expectedRevision must NOT cause a throw — non-revision
      // providers MUST silently ignore the field per the contract.
      const updated = await provider.updateMemory(actor, {
        id: created.id,
        content: "v2",
        expectedRevision: "definitely-not-current",
      });
      expect(updated.content).toBe("v2");
    });
  });

  describe("MemoryProvider conformance — ACL", () => {
    // The reference `InMemoryProvider` enforces creator-only ACL: only
    // the actor that called `saveMemory` may update or delete the
    // record. `saveMemory` itself is not authorization-gated at the
    // primitive layer — any actor can create records under any scope.
    // Backends MAY layer richer ACL (room-member, agent-group, etc.)
    // on top, but the v1 conformance suite only asserts the minimum:
    // update/delete authorization. Save-side scope-vs-actor policy is
    // explicitly provider-defined per the design doc.
    it("unauthorized actor on update raises MemoryAclError", async () => {
      const provider = makeProvider();
      if (!provider.capabilities().acl) return;
      const owner = createMockActor({ actorId: "alice" });
      const intruder = createMockActor({ actorId: "mallory" });
      const created = await provider.saveMemory(owner, {
        scope: { kind: "agent", agentId: "alice" },
        type: "user",
        content: "x",
      });
      await expect(
        provider.updateMemory(intruder, { id: created.id, content: "y" }),
      ).rejects.toBeInstanceOf(MemoryAclError);
    });

    it("unauthorized actor on delete raises MemoryAclError", async () => {
      const provider = makeProvider();
      if (!provider.capabilities().acl) return;
      const owner = createMockActor({ actorId: "alice" });
      const intruder = createMockActor({ actorId: "mallory" });
      const created = await provider.saveMemory(owner, {
        scope: { kind: "agent", agentId: "alice" },
        type: "user",
        content: "x",
      });
      await expect(provider.deleteMemory(intruder, { id: created.id })).rejects.toBeInstanceOf(
        MemoryAclError,
      );
    });
  });

  describe("MemoryProvider conformance — substrate read primitives (v0.6.0)", () => {
    // ADR 0001: get + listByScope are substrate reads, not consumer
    // queries. The harness verifies that what save/update returned is
    // actually persisted, catching "API returned record but storage
    // silently dropped it" failures.

    it("get(id) returns null for unknown id", async () => {
      const provider = makeProvider();
      const found = await provider.get("no-such-id");
      expect(found).toBe(null);
    });

    it("after save, get(id) returns the persisted record (independent read)", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      const saved = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "feedback",
        content: "verify-persisted",
      });
      const fetched = await provider.get(saved.id);
      expect(fetched).toBeDefined();
      if (fetched === null) throw new Error("get returned null after save");
      expect(fetched.id).toBe(saved.id);
      expect(fetched.content).toBe(saved.content);
      expect(fetched.scope).toEqual(saved.scope);
      expect(fetched.type).toBe(saved.type);
    });

    it("after update, get(id) reflects the new content + bumped revision", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      const created = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "user",
        content: "v1",
      });
      const updated = await provider.updateMemory(actor, { id: created.id, content: "v2" });
      const fetched = await provider.get(created.id);
      if (fetched === null) throw new Error("get returned null after update");
      expect(fetched.content).toBe("v2");
      expect(fetched.revision).toBe(updated.revision);
    });

    it("after delete, get(id) returns null", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      const created = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "user",
        content: "to-delete",
      });
      await provider.deleteMemory(actor, { id: created.id });
      const fetched = await provider.get(created.id);
      expect(fetched).toBe(null);
    });

    it("listByScope returns empty page + null cursor on empty store", async () => {
      const provider = makeProvider();
      const page = await provider.listByScope({ kind: "global" }, null, 10);
      expect(page.records).toEqual([]);
      expect(page.cursor).toBe(null);
    });

    it("listByScope filters by scope (records under other scopes excluded)", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "user",
        content: "global-1",
      });
      await provider.saveMemory(actor, {
        scope: { kind: "room", roomId: "room-a" },
        type: "user",
        content: "room-a-1",
      });
      await provider.saveMemory(actor, {
        scope: { kind: "agent", agentId: "agent-x" },
        type: "user",
        content: "agent-x-1",
      });

      const globalPage = await provider.listByScope({ kind: "global" }, null, 10);
      expect(globalPage.records.length).toBe(1);
      expect(globalPage.records[0]?.content).toBe("global-1");

      const roomPage = await provider.listByScope({ kind: "room", roomId: "room-a" }, null, 10);
      expect(roomPage.records.length).toBe(1);
      expect(roomPage.records[0]?.content).toBe("room-a-1");

      const otherRoomPage = await provider.listByScope(
        { kind: "room", roomId: "room-other" },
        null,
        10,
      );
      expect(otherRoomPage.records).toEqual([]);
    });

    it("listByScope paginates: cursor threads pages, terminal cursor is null", async () => {
      const provider = makeProvider();
      const actor = createMockActor();
      const scope = { kind: "global" } as const;
      const total = 7;
      for (let i = 0; i < total; i++) {
        await provider.saveMemory(actor, { scope, type: "user", content: `item-${i}` });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      let pagesFetched = 0;
      // Hard cap on iterations: total / limit + slack. Catches a buggy
      // provider that returns a non-null cursor forever.
      const maxIter = total + 2;
      do {
        const page = await provider.listByScope(scope, cursor, 3);
        expect(page.records.length).toBeGreaterThanOrEqual(0);
        for (const record of page.records) seen.push(record.id);
        cursor = page.cursor;
        pagesFetched++;
        if (pagesFetched > maxIter) {
          throw new Error("listByScope cursor did not terminate within max iterations");
        }
      } while (cursor !== null);

      // All records observed exactly once, no duplicates across pages.
      expect(seen.length).toBe(total);
      const unique = new Set(seen);
      expect(unique.size).toBe(total);
    });
  });
}
