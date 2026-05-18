import { describe, expect, test } from "bun:test";
import { MemoryAclError, type MemoryActor } from "@agents-js/memory";
import { LocalMemoryProvider } from "../src/local-memory-provider.ts";
import type { MemoryPolicyGate, MemoryPolicyInput } from "../src/policy-gate.ts";
import type { Storage, StoredRecord } from "../src/storage.ts";

/**
 * Integration tests for `MemoryPolicyGate` × `LocalMemoryProvider`.
 *
 * Scope vs. `policy-gate.test.ts`: that file pins the gate's
 * pure-contract shape in isolation. This file pins the provider-seam
 * invariant — the gate is consulted BEFORE any storage interaction,
 * and a non-`allow` decision lifts into `MemoryAclError` regardless of
 * downstream provider state.
 */

const actor: MemoryActor = { kind: "agent", actorId: "alice" };

function existingRecord(): StoredRecord {
  return {
    id: "mem_1",
    scope: { kind: "agent", agentId: "alice" },
    type: "user",
    content: "stored",
    metadata: {},
    createdAtMs: 1,
    updatedAtMs: 1,
    revision: "1",
    creator: actor,
  };
}

/**
 * A storage stub that surfaces the pre-existing record for update/delete
 * (so the orchestrator can load real scope/type before invoking the gate)
 * but records any MUTATING call into `callsThatShouldNeverHappen` so the
 * test can assert the gate short-circuited before any write.
 */
function readableStorage(record: StoredRecord | undefined = existingRecord()): Storage {
  return {
    async insertRecord(rec) {
      callsThatShouldNeverHappen.push(`insertRecord:${rec.id}`);
      return rec;
    },
    async updateRecord(id) {
      callsThatShouldNeverHappen.push(`updateRecord:${id}`);
      throw new Error("must not be called when gate vetoes");
    },
    async getRecord() {
      return record;
    },
    async deleteRecord(id) {
      callsThatShouldNeverHappen.push(`deleteRecord:${id}`);
      return false;
    },
    async findByIdempotency() {
      return undefined;
    },
    async listByScope() {
      return { records: [], cursor: null };
    },
    async close() {},
  };
}

function noopStorage(): Storage {
  return readableStorage(undefined);
}

let callsThatShouldNeverHappen: string[] = [];

function gateThat(
  decisionFor: Record<string, "allow" | "deny" | "ask">,
  seenSink?: MemoryPolicyInput[],
): MemoryPolicyGate {
  return {
    async evaluate(input) {
      if (seenSink) seenSink.push(input);
      const decision = decisionFor[input.op] ?? "allow";
      return { decision, reason: decision === "allow" ? undefined : `${input.op} blocked` };
    },
  };
}

describe("LocalMemoryProvider × MemoryPolicyGate — integration", () => {
  // Intent: a `deny` decision on save MUST raise `MemoryAclError` before
  // any storage write. The seam guarantees the gate is consulted first;
  // a denied save never touches the backend. We assert both the error
  // type AND the absence of any storage side-effect.
  test("policy-gate veto on save raises MemoryAclError before any storage write", async () => {
    callsThatShouldNeverHappen = [];
    const provider = new LocalMemoryProvider({
      storage: noopStorage(),
      policyGate: gateThat({ save: "deny" }),
    });

    await expect(
      provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "user",
        content: "hi",
      }),
    ).rejects.toBeInstanceOf(MemoryAclError);

    expect(callsThatShouldNeverHappen).toEqual([]);
  });

  // Intent: a `deny` on update MUST raise `MemoryAclError` and MUST NOT
  // mutate any storage state. The orchestrator pre-loads the record via
  // `getRecord` so the gate sees the real scope/type; only the MUTATING
  // call (`updateRecord`) is forbidden when the gate vetoes.
  test("policy-gate veto on update raises MemoryAclError; record remains unchanged", async () => {
    callsThatShouldNeverHappen = [];
    const provider = new LocalMemoryProvider({
      storage: readableStorage(),
      policyGate: gateThat({ update: "deny" }),
    });

    await expect(
      provider.updateMemory(actor, { id: "mem_1", content: "patched" }),
    ).rejects.toBeInstanceOf(MemoryAclError);

    // updateRecord is the only mutating call; absence here proves the
    // gate short-circuited before storage write.
    expect(callsThatShouldNeverHappen).toEqual([]);
  });

  // Intent: a `deny` on delete MUST raise `MemoryAclError` and MUST NOT
  // call `deleteRecord` on the seam. Mirror of the update test for the
  // third op.
  test("policy-gate veto on delete raises MemoryAclError; record remains present", async () => {
    callsThatShouldNeverHappen = [];
    const provider = new LocalMemoryProvider({
      storage: readableStorage(),
      policyGate: gateThat({ delete: "deny" }),
    });

    await expect(provider.deleteMemory(actor, { id: "mem_1" })).rejects.toBeInstanceOf(
      MemoryAclError,
    );

    expect(callsThatShouldNeverHappen).toEqual([]);
  });

  // Intent: in v1, there is no interactive host wired to the gate, so
  // an `ask` decision MUST be treated as `deny`. The provider lifts it
  // into the same `MemoryAclError`. When a later version wires a real
  // human-in-the-loop host, this test will be updated to assert a
  // prompt-pending pathway instead.
  test("policy-gate 'ask' decision is treated as deny in v1 (no interactive host)", async () => {
    callsThatShouldNeverHappen = [];
    const provider = new LocalMemoryProvider({
      storage: noopStorage(),
      policyGate: gateThat({ save: "ask" }),
    });

    await expect(
      provider.saveMemory(actor, {
        scope: { kind: "global" },
        type: "user",
        content: "needs review",
      }),
    ).rejects.toBeInstanceOf(MemoryAclError);

    expect(callsThatShouldNeverHappen).toEqual([]);
  });

  // Intent: the gate sees the same `metadata` the caller supplied to
  // the primitive (a consent token, an audit-trail id, etc.). This pins
  // the pass-through contract so policy authors can rely on
  // `input.metadata?.consentToken` and similar fields.
  test("policy-gate observes pass-through metadata (consent token presence)", async () => {
    const seen: MemoryPolicyInput[] = [];
    const provider = new LocalMemoryProvider({
      storage: noopStorage(),
      // Deny so the call short-circuits cleanly; we only care about the
      // input the gate saw.
      policyGate: gateThat({ save: "deny" }, seen),
    });

    await expect(
      provider.saveMemory(actor, {
        scope: { kind: "agent", agentId: "alice" },
        type: "feedback",
        content: "reviewed",
        metadata: { consentToken: "tok_abc123" },
      }),
    ).rejects.toBeInstanceOf(MemoryAclError);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.op).toBe("save");
    expect(seen[0]?.actor).toEqual(actor);
    expect(seen[0]?.scope).toEqual({ kind: "agent", agentId: "alice" });
    expect(seen[0]?.type).toBe("feedback");
    expect(seen[0]?.metadata).toEqual({ consentToken: "tok_abc123" });
  });

  // Intent: omitting `policyGate` MUST default to `noopPolicyGate` —
  // every decision is `allow`, and the provider proceeds to its normal
  // path. With the orchestrator landed, that means a save against the
  // (echoing) storage stub returns a populated record. Built-in
  // creator-only ACL still applies for update/delete; the gate stays
  // out of the way.
  test("noopPolicyGate is the default — no gate construction option permits save", async () => {
    const provider = new LocalMemoryProvider({ storage: noopStorage() });

    const saved = await provider.saveMemory(actor, {
      scope: { kind: "global" },
      type: "user",
      content: "default-gate path",
    });
    expect(saved.id).toBeDefined();
    expect(saved.content).toBe("default-gate path");
  });
});
