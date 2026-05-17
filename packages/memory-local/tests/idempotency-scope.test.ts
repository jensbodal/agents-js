import { describe, expect, test } from "bun:test";
import type { MemoryActor, SaveMemoryInput } from "@agents-js/memory";
import { LocalMemoryProvider } from "../src/local-memory-provider.ts";
import { SqliteStorage } from "../src/sqlite-storage.ts";

/**
 * Idempotency keys MUST be scoped to (creator.kind, creator.actorId, key).
 * Two distinct actors using the same key produce DISTINCT records — the
 * key namespace is per-actor, never global. Anything else would let one
 * actor squat on another's writes by guessing keys.
 */

const sharedInput = (): SaveMemoryInput => ({
  scope: { kind: "global" },
  type: "user",
  content: "x",
  idempotencyKey: "shared-key",
});

describe("LocalMemoryProvider — idempotency key scoping", () => {
  test("two actors with same key get DISTINCT ids", async () => {
    const provider = new LocalMemoryProvider({
      storage: new SqliteStorage({ dbPath: ":memory:" }),
    });
    const alice: MemoryActor = { kind: "agent", actorId: "alice" };
    const bob: MemoryActor = { kind: "agent", actorId: "bob" };

    const a = await provider.saveMemory(alice, sharedInput());
    const b = await provider.saveMemory(bob, sharedInput());

    expect(a.id).not.toBe(b.id);
  });

  test("same actor + same key returns SAME id (dedup within actor scope)", async () => {
    const provider = new LocalMemoryProvider({
      storage: new SqliteStorage({ dbPath: ":memory:" }),
    });
    const alice: MemoryActor = { kind: "agent", actorId: "alice" };

    const a = await provider.saveMemory(alice, sharedInput());
    const b = await provider.saveMemory(alice, sharedInput());

    expect(b.id).toBe(a.id);
  });

  test("different actor kinds with same actorId + same key are DISTINCT", async () => {
    const provider = new LocalMemoryProvider({
      storage: new SqliteStorage({ dbPath: ":memory:" }),
    });
    const agentAlice: MemoryActor = { kind: "agent", actorId: "alice" };
    const humanAlice: MemoryActor = { kind: "human", actorId: "alice" };

    const a = await provider.saveMemory(agentAlice, sharedInput());
    const b = await provider.saveMemory(humanAlice, sharedInput());

    expect(a.id).not.toBe(b.id);
  });
});
