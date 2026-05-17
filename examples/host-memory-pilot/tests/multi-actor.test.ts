import { describe, expect, test } from "bun:test";
import type { MemoryActor } from "@agents-js/memory";
import { LocalMemoryProvider, noopPolicyGate, SqliteStorage } from "@agents-js/memory-local";

/**
 * Intent: prove the provider serves writes from every `MemoryActor.kind`
 * variant — including `service`, the kind added in PR #18 (8e8e4ce6)
 * for non-interactive callers (cron, health checks, CI pipelines,
 * scheduled jobs). The host-side conformance suite covers `agent`-kind
 * write behavior already; this adds explicit pins on the kinds the
 * conformance harness does NOT exercise.
 */

const agent: MemoryActor = { kind: "agent", actorId: "planner-1" };
const human: MemoryActor = { kind: "human", actorId: "jens" };
const service: MemoryActor = { kind: "service", actorId: "cron-smoke-1" };

function freshProvider(): LocalMemoryProvider {
  return new LocalMemoryProvider({
    storage: new SqliteStorage({ dbPath: ":memory:" }),
    policyGate: noopPolicyGate,
  });
}

describe("host-memory-pilot — multi-actor coverage", () => {
  test("all three MemoryActor.kind variants round-trip save → update → delete", async () => {
    const provider = freshProvider();
    for (const actor of [agent, human, service]) {
      const saved = await provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "user",
        content: `${actor.kind}:${actor.actorId} initial`,
      });
      expect(saved.id).toBeDefined();
      expect(saved.revision).toBe("1");

      const updated = await provider.updateMemory(actor, {
        id: saved.id,
        content: `${actor.kind}:${actor.actorId} rotated`,
      });
      expect(updated.id).toBe(saved.id);
      expect(updated.revision).toBe("2");

      await provider.deleteMemory(actor, { id: saved.id });
      // Subsequent update on a deleted id throws — provider contract
      // is "missing-id update is an error," documented in the
      // primitive types.
      await expect(
        provider.updateMemory(actor, { id: saved.id, content: "should fail" }),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  test("service-actor writes carry creator provenance distinguishable from agent / human", async () => {
    // ACL-only providers attach the creator to the record. We can't
    // read the creator back via the v1 surface (no list/query), so we
    // assert behavior at the gate seam: a non-creator can't update or
    // delete. This pins service-actor identity isolation symmetrically
    // with the agent / human kinds.
    const provider = freshProvider();
    const savedByService = await provider.saveMemory(service, {
      scope: { kind: "global" },
      type: "reference",
      content: "service-owned record",
    });

    const impersonator: MemoryActor = { kind: "agent", actorId: service.actorId };
    await expect(
      provider.updateMemory(impersonator, {
        id: savedByService.id,
        content: "should be denied — different kind same actorId",
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
