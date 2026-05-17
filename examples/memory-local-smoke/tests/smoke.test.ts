import { describe, expect, test } from "bun:test";
import type { MemoryActor, SaveMemoryInput } from "@agents-js/memory";
import {
  LocalMemoryProvider,
  MemoryAclError,
  type MemoryPolicyGate,
  SqliteStorage,
} from "@agents-js/memory-local";

const actor: MemoryActor = { kind: "agent", actorId: "smoke-test-agent" };

const denyGlobalGate: MemoryPolicyGate = {
  async evaluate(input) {
    if (input.scope.kind === "global") {
      return { decision: "deny", reason: "global writes require admin" };
    }
    return { decision: "allow" };
  },
};

describe("memory-local-smoke", () => {
  // Intent: the deny path is fully wired end-to-end against the
  // public surface of @agents-js/memory-local. This proves a real
  // consumer can import the package, supply a gate, and rely on
  // MemoryAclError before any storage write occurs.
  test("policy-gate deny on global scope raises MemoryAclError via the public package surface", async () => {
    const provider = new LocalMemoryProvider({
      storage: new SqliteStorage({ dbPath: ":memory:" }),
      policyGate: denyGlobalGate,
    });
    const input: SaveMemoryInput = {
      scope: { kind: "global" },
      type: "user",
      content: "should be denied",
    };
    await expect(provider.saveMemory(actor, input)).rejects.toBeInstanceOf(MemoryAclError);
  });

  // Intent: the orchestrator + SqliteStorage perform a real round-trip
  // (save -> update -> delete) against an in-memory sqlite db. Pins
  // the public surface for downstream consumers.
  test("round-trip: save -> update -> delete via LocalMemoryProvider + SqliteStorage", async () => {
    const provider = new LocalMemoryProvider({
      storage: new SqliteStorage({ dbPath: ":memory:" }),
      policyGate: denyGlobalGate,
    });

    const saved = await provider.saveMemory(actor, {
      scope: { kind: "agent", agentId: "smoke-test-agent" },
      type: "feedback",
      content: "v1",
    });
    expect(saved.id).toBeDefined();
    expect(saved.revision).toBe("1");

    const updated = await provider.updateMemory(actor, { id: saved.id, content: "v2" });
    expect(updated.id).toBe(saved.id);
    expect(updated.content).toBe("v2");
    expect(updated.revision).toBe("2");

    await provider.deleteMemory(actor, { id: saved.id });
    await expect(
      provider.updateMemory(actor, { id: saved.id, content: "v3" }),
    ).rejects.toBeInstanceOf(Error);
  });
});
