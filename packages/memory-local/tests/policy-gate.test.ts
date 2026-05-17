import { describe, expect, test } from "bun:test";
import type { MemoryPolicyGate } from "../src/policy-gate.ts";
import { noopPolicyGate } from "../src/policy-gate.ts";

/**
 * Shape tests for the policy-gate contract.
 *
 * These tests pin the shape and the default-deny-by-omission semantics
 * for downstream consumers. Human-in-the-loop behavior tests against a
 * real interactive gate are deferred to a later version.
 */

describe("MemoryPolicyGate — interface contract", () => {
  // Intent: the default gate must be a true no-op — every call returns
  // `allow` without inspecting the input. This is the v1 default so that
  // the provider works out-of-the-box with no policy plumbing.
  test("noopPolicyGate returns {decision: 'allow'} for any input", async () => {
    const inputs = [
      {
        op: "save" as const,
        actor: { kind: "agent" as const, actorId: "a1" },
        scope: { kind: "global" as const },
        type: "user",
      },
      {
        op: "update" as const,
        actor: { kind: "human" as const, actorId: "u1" },
        scope: { kind: "agent" as const, agentId: "a1" },
        type: "feedback",
        metadata: { source: "test" },
      },
      {
        op: "delete" as const,
        actor: { kind: "agent" as const, actorId: "a2" },
        scope: { kind: "room" as const, roomId: "r1" },
        type: "project",
      },
    ];

    for (const input of inputs) {
      const result = await noopPolicyGate.evaluate(input);
      expect(result.decision).toBe("allow");
    }
  });

  // Intent: a custom gate that returns `deny` MUST surface a reason
  // string. The provider lifts that reason into the MemoryAclError it
  // throws back at the caller, so the reason is load-bearing for
  // diagnostics.
  test("a custom gate returning {decision: 'deny', reason} surfaces the reason", async () => {
    const gate: MemoryPolicyGate = {
      async evaluate(input) {
        if (input.scope.kind === "global") {
          return { decision: "deny", reason: "global scope writes require admin" };
        }
        return { decision: "allow" };
      },
    };

    const denied = await gate.evaluate({
      op: "save",
      actor: { kind: "agent", actorId: "a1" },
      scope: { kind: "global" },
      type: "user",
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toBe("global scope writes require admin");

    const allowed = await gate.evaluate({
      op: "save",
      actor: { kind: "agent", actorId: "a1" },
      scope: { kind: "agent", agentId: "a1" },
      type: "user",
    });
    expect(allowed.decision).toBe("allow");
  });

  // Intent: in v1 the gate is a pure decision reporter — it does NOT
  // open a prompt or block. The provider treats `ask` as `deny` until
  // a later version lands real human-in-the-loop. This test pins that
  // the gate contract simply reports the decision; the caller-side
  // semantic (ask -> treat-as-deny) is documented but enforced by the
  // provider, not by the gate.
  test("a custom gate returning {decision: 'ask'} is treated by the gate caller as deny in v1 (caller-side semantic, gate just reports decision)", async () => {
    const gate: MemoryPolicyGate = {
      async evaluate() {
        return { decision: "ask", reason: "human review required" };
      },
    };

    const result = await gate.evaluate({
      op: "delete",
      actor: { kind: "agent", actorId: "a1" },
      scope: { kind: "room", roomId: "r1" },
      type: "user",
    });

    // The gate itself just reports — it does NOT downgrade `ask` to `deny`.
    expect(result.decision).toBe("ask");
    expect(result.reason).toBe("human review required");

    // Caller-side semantic (documented; provider enforces this):
    // treat anything that is not strictly "allow" as a denial in v1.
    const effective: "allow" | "deny" = result.decision === "allow" ? "allow" : "deny";
    expect(effective).toBe("deny");
  });
});
