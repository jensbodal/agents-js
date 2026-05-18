import { describe, expect, it } from "bun:test";
import {
  MemoryAclError,
  type MemoryActor,
  type MemoryProvider,
  type MemoryRecord,
  MemoryRevisionConflictError,
  type MemoryScope,
  type MemoryType,
  type ProviderCapabilities,
  type SaveMemoryInput,
} from "../src/index.ts";

/**
 * Compile-time-only smoke test — proves the package's public types
 * compile from a consumer-side import without runtime side effects.
 * Each `_` binding forces the type to be referenced at type-check time;
 * the runtime test below only checks that the error classes are
 * constructable, since types disappear after compilation.
 */
describe("@agents-js/memory — type-only smoke", () => {
  it("public types are importable and shape-stable", () => {
    const scope: MemoryScope = { kind: "global" };
    const actor: MemoryActor = { kind: "agent", actorId: "smoke" };
    const type: MemoryType = "feedback";
    const caps: ProviderCapabilities = { idempotency: true, revisions: true, acl: true };
    const input: SaveMemoryInput = { scope, type, content: "x" };

    // Provider interface satisfies a stub — proves the contract compiles
    // for consumers writing their own implementations.
    const _stub: MemoryProvider = {
      saveMemory: async (_a, _i) => {
        const r: MemoryRecord = {
          id: "x",
          scope,
          type,
          content: "x",
          metadata: {},
          createdAtMs: 0,
          updatedAtMs: 0,
        };
        return r;
      },
      updateMemory: async (_a, _i) => {
        throw new Error("stub");
      },
      deleteMemory: async (_a, _i) => undefined,
      capabilities: () => caps,
      get: async () => null,
      listByScope: async () => ({ records: [], cursor: null }),
    };

    expect(scope.kind).toBe("global");
    expect(actor.actorId).toBe("smoke");
    expect(input.content).toBe("x");
    expect(_stub.capabilities().acl).toBe(true);
  });

  it("error classes are constructable + carry their structured fields", () => {
    const actor: MemoryActor = { kind: "human", actorId: "alice" };
    const scope: MemoryScope = { kind: "agent", agentId: "bob" };
    const aclErr = new MemoryAclError(actor, scope);
    expect(aclErr).toBeInstanceOf(Error);
    expect(aclErr.name).toBe("MemoryAclError");
    expect(aclErr.actor).toEqual(actor);
    expect(aclErr.scope).toEqual(scope);

    const revErr = new MemoryRevisionConflictError("rec_1", "3");
    expect(revErr).toBeInstanceOf(Error);
    expect(revErr.name).toBe("MemoryRevisionConflictError");
    expect(revErr.id).toBe("rec_1");
    expect(revErr.currentRevision).toBe("3");
  });
});
