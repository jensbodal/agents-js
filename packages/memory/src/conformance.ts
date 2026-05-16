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
 * Drop-in conformance suite. v1 has no read surface, so cross-record
 * visibility tests are deferred to v2 — the suite only exercises what
 * is observable through `saveMemory`, `updateMemory`, `deleteMemory`,
 * and the returned `MemoryRecord`.
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
}
