import { describe, expect, it } from "bun:test";
import { MemoryAclError, type MemoryActor, type MemoryScope } from "@agents-js/memory";
import { MapBackedProvider } from "../src/map-backed-provider.ts";

const actor: MemoryActor = { kind: "agent", actorId: "pilot-regression" };

describe("MapBackedProvider — regression (consumer-pilot local)", () => {
  it("no-op update returns the existing record with revision + updatedAtMs unchanged", async () => {
    const provider = new MapBackedProvider();
    const saved = await provider.saveMemory(actor, {
      scope: { kind: "global" },
      type: "feedback",
      content: "x",
    });
    const beforeRevision = saved.revision;
    const beforeUpdated = saved.updatedAtMs;

    // No-op: only id, no content, no metadata. The primitive's contract
    // (UpdateMemoryInput.content JSDoc) says revision/updatedAtMs MUST NOT advance.
    const after = await provider.updateMemory(actor, { id: saved.id });

    expect(after.revision).toBe(beforeRevision);
    expect(after.updatedAtMs).toBe(beforeUpdated);
    expect(after.id).toBe(saved.id);
    expect(after.content).toBe("x");
  });

  it("mutating save inputs after the call does not leak into provider state", async () => {
    const provider = new MapBackedProvider();
    const scope: MemoryScope = { kind: "agent", agentId: "alice" };
    const metadata: Record<string, unknown> = { tag: "original" };

    const saved = await provider.saveMemory(actor, {
      scope,
      type: "feedback",
      content: "hello",
      metadata,
    });

    // Mutate the caller-owned input objects AFTER the save.
    (scope as { agentId: string }).agentId = "bob";
    metadata.tag = "mutated";
    (metadata as Record<string, unknown>).newKey = "injected";

    // Re-fetch via no-op update and assert provider state is untouched.
    const refetched = await provider.updateMemory(actor, { id: saved.id });

    expect(refetched.scope).toEqual({ kind: "agent", agentId: "alice" });
    expect(refetched.metadata).toEqual({ tag: "original" });
  });

  it("mutating update inputs after the call does not leak into provider state", async () => {
    const provider = new MapBackedProvider();
    const saved = await provider.saveMemory(actor, {
      scope: { kind: "global" },
      type: "feedback",
      content: "v1",
    });

    const updateMetadata: Record<string, unknown> = { stage: "first" };
    await provider.updateMemory(actor, { id: saved.id, metadata: updateMetadata });

    // Mutate the input after the update returns.
    updateMetadata.stage = "tampered";
    (updateMetadata as Record<string, unknown>).extra = "injected";

    const refetched = await provider.updateMemory(actor, { id: saved.id });
    expect(refetched.metadata).toEqual({ stage: "first" });
  });

  it("mutating ACL error scope does not leak into provider state", async () => {
    const provider = new MapBackedProvider();
    const owner: MemoryActor = { kind: "agent", actorId: "alice" };
    const intruder: MemoryActor = { kind: "agent", actorId: "mallory" };
    const saved = await provider.saveMemory(owner, {
      scope: { kind: "agent", agentId: "alice" },
      type: "feedback",
      content: "private",
    });

    try {
      await provider.updateMemory(intruder, { id: saved.id, content: "tamper" });
      throw new Error("expected ACL failure");
    } catch (err) {
      expect(err).toBeInstanceOf(MemoryAclError);
      const aclErr = err as MemoryAclError;
      if (aclErr.scope.kind === "agent") {
        aclErr.scope.agentId = "mallory";
      }
    }

    const refetched = await provider.updateMemory(owner, { id: saved.id });
    expect(refetched.scope).toEqual({ kind: "agent", agentId: "alice" });
  });
});
