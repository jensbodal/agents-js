import type { MemoryActor, MemoryScope, MemoryType } from "@agents-js/memory";

export type MemoryPolicyOp = "save" | "update" | "delete";

export interface MemoryPolicyInput {
  op: MemoryPolicyOp;
  actor: MemoryActor;
  scope: MemoryScope;
  type: MemoryType;
  metadata?: Record<string, unknown>;
}

export type MemoryPolicyDecision = "allow" | "ask" | "deny";

export interface MemoryPolicyResult {
  decision: MemoryPolicyDecision;
  /**
   * Optional human-readable reason. Required for `deny` if the caller
   * wants the reason surfaced through `MemoryAclError`; recommended
   * for `ask` to populate any prompt UI.
   */
  reason?: string;
}

/**
 * Optional policy hook injected into `LocalMemoryProvider`. Evaluated
 * BEFORE the storage call; the provider lifts a `deny` (and, in v1,
 * `ask`) into a `MemoryAclError`. The interactive `"ask"` variant is
 * deferred to a later version; the gate contract itself is a pure
 * decision reporter.
 */
export interface MemoryPolicyGate {
  evaluate(input: MemoryPolicyInput): Promise<MemoryPolicyResult>;
}

/**
 * Default gate — always allows. Lets the provider work out of the box
 * with no policy plumbing. Callers opt in to enforcement by supplying
 * their own gate.
 */
export const noopPolicyGate: MemoryPolicyGate = {
  async evaluate(): Promise<MemoryPolicyResult> {
    return { decision: "allow" };
  },
};
