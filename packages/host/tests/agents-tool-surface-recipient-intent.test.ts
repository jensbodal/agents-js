/**
 * AJS-67 recipient-intent quorum contract.
 *
 * Pins the 11 behavior cases from the §8.3 acceptance gate of the
 * AJS-67 design doc (vault path:
 * `agents-js/docs/protocols/ajs-67-recipient-intent-quorum.md`):
 *
 *   1. Single-target Matrix-visible (no quorum required; envelope inferred)
 *   2. Single-target inbox-only (no quorum, no envelope)
 *   3. Multi-target all-inbox-only (no quorum required, no intent metadata)
 *   4. Multi-target one-Matrix-visible (no quorum required, intent
 *      metadata reports required:false, satisfied:true)
 *   5. Multi-target multi-Matrix-visible with satisfying recipient_quorum
 *      (success path)
 *   6. Multi-target multi-Matrix-visible MISSING recipient_quorum →
 *      recipient-intent-required rejection (pre-send)
 *   7. recipient_quorum.at_least > matrix_visible_targets.length →
 *      recipient-quorum-unsatisfiable rejection
 *   8. Mixed Matrix + inbox routes with recipient_quorum counting Matrix
 *      subset only
 *   9. Proof that threshold.at_least satisfying does NOT satisfy
 *      recipient_quorum requirement (independent assertion)
 *  10. recipient_intent.matrix_visible_targets cross-references
 *      PerTargetResult entries by name
 *  11. recipient-intent rejection happens BEFORE per-target timer armed
 *      (no leaked setTimeout handles)
 *
 * Plus bridge-envelope coverage: matrix-notify carries `recipients`
 * envelope alongside body for both single and multi-target paths.
 */

import { describe, expect, test } from "bun:test";
import {
  type AgentInboxTool,
  type AgentsDispatcher,
  createAgentsDispatcher,
  isFanOutSendResult,
  type MatrixSendArgs,
  type MatrixTool,
  type SendMessageResult,
  type TargetDirectory,
} from "../src/agents-tool-surface.ts";
import type { AuthenticatedIdentity } from "../src/jwt-verifier.ts";

function identity(opts: Partial<AuthenticatedIdentity> = {}): AuthenticatedIdentity {
  return {
    agentName: opts.agentName ?? "caller",
    scopes: opts.scopes ?? ["matrix.send_message", "inbox.deliver", "matrix.read"],
    correlationId: opts.correlationId ?? "cid-ri-001",
    issuer: opts.issuer ?? "test",
    expiresAt: opts.expiresAt ?? Math.floor(Date.now() / 1000) + 900,
  };
}

function makeDirectory(
  entries: Record<string, { matrix?: { room: string }; inbox?: { session: string } }>,
): TargetDirectory {
  return { resolve: (t) => entries[t] ?? null };
}

function makeMatrixTool(): MatrixTool & { calls: MatrixSendArgs[] } {
  const calls: MatrixSendArgs[] = [];
  let n = 0;
  return {
    calls,
    async send(args) {
      calls.push(args);
      n += 1;
      return { event_id: `$evt-${n}` };
    },
  };
}

function makeInboxTool(): AgentInboxTool & {
  calls: Array<{ toSession: string; body: string }>;
} {
  const calls: Array<{ toSession: string; body: string }> = [];
  let n = 0;
  return {
    calls,
    async deliver({ toSession, body }) {
      calls.push({ toSession, body });
      n += 1;
      return { message_id: `msg-${n}`, created_at: new Date(0).toISOString() };
    },
    async read() {
      return [];
    },
  };
}

function makeDispatcher(opts: {
  matrixTool?: MatrixTool;
  agentInboxTool?: AgentInboxTool;
  targetDirectory: TargetDirectory;
}): AgentsDispatcher {
  return createAgentsDispatcher({
    matrixTool: opts.matrixTool ?? makeMatrixTool(),
    ...(opts.agentInboxTool ? { agentInboxTool: opts.agentInboxTool } : {}),
    targetDirectory: opts.targetDirectory,
  });
}

function assertFanOut(
  r: SendMessageResult,
): asserts r is Extract<SendMessageResult, { results: unknown }> {
  if (!isFanOutSendResult(r)) throw new Error(`expected fan-out result; got ${JSON.stringify(r)}`);
}

function assertSingleOk(
  r: SendMessageResult,
): asserts r is Exclude<Extract<SendMessageResult, { ok: true }>, { results: unknown[] }> {
  if (!r.ok) throw new Error(`expected ok=true; got error=${r.error}`);
  if (isFanOutSendResult(r)) throw new Error("expected single-target shape; got fan-out result");
}

describe("packages/host/tests/agents-tool-surface-recipient-intent.test.ts — AJS-67 contract", () => {
  /**
   * Case 1 — single-target Matrix-visible.
   *
   * No `recipient_quorum` required (n=1 inference). Matrix-notify call
   * carries the `recipients` envelope with `explicit: [target]` +
   * `quorum_attested: true`. Response shape stays single-target back-compat
   * (no `recipient_intent` field in the response; envelope flows downstream
   * to bridge only).
   */
  test("single-target Matrix-visible → no quorum required; bridge envelope inferred", async () => {
    const matrix = makeMatrixTool();
    const inbox = makeInboxTool();
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      agentInboxTool: inbox,
      targetDirectory: makeDirectory({
        alice: { matrix: { room: "!alice:matrix.example" }, inbox: { session: "alice" } },
      }),
    });
    const result = await dispatcher.sendMessage({ target: "alice", body: "hi" }, identity());
    assertSingleOk(result);
    expect(result.inbox_message_id).toBe("msg-1");
    expect(result.event_id).toBe("$evt-1");
    expect(matrix.calls).toHaveLength(1);
    expect(matrix.calls[0]?.recipients).toEqual({
      explicit: ["alice"],
      quorum_attested: true,
    });
    // Single-target response shape never carries recipient_intent.
    expect((result as { recipient_intent?: unknown }).recipient_intent).toBeUndefined();
  });

  /**
   * Case 2 — single-target inbox-only.
   *
   * No matrix-notify fires. No `recipients` envelope. No `recipient_intent`
   * in response.
   */
  test("single-target inbox-only → no envelope, no intent metadata", async () => {
    const matrix = makeMatrixTool();
    const inbox = makeInboxTool();
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      agentInboxTool: inbox,
      targetDirectory: makeDirectory({
        alice: { inbox: { session: "alice" } },
      }),
    });
    const result = await dispatcher.sendMessage({ target: "alice", body: "hi" }, identity());
    assertSingleOk(result);
    expect(result.inbox_message_id).toBe("msg-1");
    expect(result.event_id).toBeUndefined();
    expect(matrix.calls).toHaveLength(0);
  });

  /**
   * Case 3 — multi-target all-inbox-only.
   *
   * No quorum required (`matrix_visible_targets.length === 0`); no
   * `recipient_intent` in response (absent for all-inbox calls per
   * design doc §6.2).
   */
  test("multi-target all-inbox-only → no quorum required, no recipient_intent metadata", async () => {
    const dispatcher = makeDispatcher({
      agentInboxTool: makeInboxTool(),
      targetDirectory: makeDirectory({
        alice: { inbox: { session: "alice" } },
        bob: { inbox: { session: "bob" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      { targets: ["alice", "bob"], body: "hi" },
      identity(),
    );
    assertFanOut(result);
    expect(result.delivered).toBe(2);
    expect(result.recipient_intent).toBeUndefined();
  });

  /**
   * Case 4 — multi-target with exactly one Matrix-visible.
   *
   * `matrix_visible_targets.length === 1` → no explicit quorum required
   * (singular inference). Response carries `recipient_intent` for caller
   * observability with `required: false`, `satisfied: true`, and the
   * singular Matrix-visible target name.
   */
  test("multi-target one Matrix-visible → required:false, satisfied:true, envelope inferred", async () => {
    const matrix = makeMatrixTool();
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      agentInboxTool: makeInboxTool(),
      targetDirectory: makeDirectory({
        alice: { matrix: { room: "!alice:matrix.example" }, inbox: { session: "alice" } },
        bob: { inbox: { session: "bob" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      { targets: ["alice", "bob"], body: "hi" },
      identity(),
    );
    assertFanOut(result);
    expect(result.delivered).toBe(2);
    expect(result.recipient_intent).toEqual({
      required: false,
      satisfied: true,
      matrix_visible_targets: ["alice"],
    });
    // Bridge envelope on the alice matrix call only.
    expect(matrix.calls).toHaveLength(1);
    expect(matrix.calls[0]?.recipients).toEqual({
      explicit: ["alice"],
      quorum_attested: true,
    });
  });

  /**
   * Case 5 — multi-Matrix-visible with satisfying recipient_quorum.
   *
   * Every Matrix-notify carries the SAME envelope (broadcast intent is
   * call-wide, not per-target). `recipient_intent` reports
   * `required: true, satisfied: true`.
   */
  test("multi-Matrix-visible with satisfying recipient_quorum → succeeds + envelope shared across targets", async () => {
    const matrix = makeMatrixTool();
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      agentInboxTool: makeInboxTool(),
      targetDirectory: makeDirectory({
        alice: { matrix: { room: "!alice:matrix.example" }, inbox: { session: "alice" } },
        bob: { matrix: { room: "!bob:matrix.example" }, inbox: { session: "bob" } },
        carol: { matrix: { room: "!carol:matrix.example" }, inbox: { session: "carol" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      {
        targets: ["alice", "bob", "carol"],
        recipient_quorum: { at_least: 3 },
        body: "hi",
      },
      identity(),
    );
    assertFanOut(result);
    expect(result.delivered).toBe(3);
    expect(result.recipient_intent).toEqual({
      required: true,
      satisfied: true,
      matrix_visible_targets: ["alice", "bob", "carol"],
    });
    expect(matrix.calls).toHaveLength(3);
    // Every matrix call carries the same envelope.
    for (const call of matrix.calls) {
      expect(call.recipients).toEqual({
        explicit: ["alice", "bob", "carol"],
        quorum_attested: true,
      });
    }
  });

  /**
   * Case 6 — multi-Matrix-visible missing recipient_quorum.
   *
   * Pre-send rejection at top-level. No per-target sends initiated; no
   * inbox-write calls; no matrix-notify calls. Reason
   * `recipient-intent-required`.
   */
  test("multi-Matrix-visible MISSING recipient_quorum → recipient-intent-required (pre-send)", async () => {
    const matrix = makeMatrixTool();
    const inbox = makeInboxTool();
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      agentInboxTool: inbox,
      targetDirectory: makeDirectory({
        alice: { matrix: { room: "!alice:matrix.example" }, inbox: { session: "alice" } },
        bob: { matrix: { room: "!bob:matrix.example" }, inbox: { session: "bob" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      { targets: ["alice", "bob"], body: "hi" },
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("recipient-intent-required");
    // No sends initiated.
    expect(matrix.calls).toHaveLength(0);
    expect(inbox.calls).toHaveLength(0);
  });

  /**
   * Case 7 — recipient_quorum.at_least exceeds matrix_visible count.
   *
   * Pre-send rejection with `recipient-quorum-unsatisfiable`. Disambiguates
   * from `invalid-args` (per design doc §9 open Q1 ratification) so callers
   * can distinguish "shape is bad" from "shape can't satisfy intent".
   */
  test("recipient_quorum.at_least > matrix_visible.length → recipient-quorum-unsatisfiable", async () => {
    const dispatcher = makeDispatcher({
      agentInboxTool: makeInboxTool(),
      targetDirectory: makeDirectory({
        alice: { matrix: { room: "!a:m" }, inbox: { session: "alice" } },
        bob: { matrix: { room: "!b:m" }, inbox: { session: "bob" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      { targets: ["alice", "bob"], recipient_quorum: { at_least: 3 }, body: "hi" },
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("recipient-quorum-unsatisfiable");
  });

  /**
   * Case 8 — mixed Matrix + inbox routes; recipient_quorum counts the
   * Matrix-visible subset only.
   *
   * Three targets: alice (matrix+inbox), bob (matrix+inbox), carol
   * (inbox-only). `matrix_visible_targets === [alice, bob]`. A
   * `recipient_quorum.at_least: 2` is satisfiable (within Matrix-subset
   * bounds). Delivery covers all 3 (inbox writes).
   */
  test("mixed routes: recipient_quorum counts Matrix-visible subset only", async () => {
    const matrix = makeMatrixTool();
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      agentInboxTool: makeInboxTool(),
      targetDirectory: makeDirectory({
        alice: { matrix: { room: "!a:m" }, inbox: { session: "alice" } },
        bob: { matrix: { room: "!b:m" }, inbox: { session: "bob" } },
        carol: { inbox: { session: "carol" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      {
        targets: ["alice", "bob", "carol"],
        recipient_quorum: { at_least: 2 },
        body: "hi",
      },
      identity(),
    );
    assertFanOut(result);
    expect(result.delivered).toBe(3);
    expect(result.recipient_intent).toEqual({
      required: true,
      satisfied: true,
      matrix_visible_targets: ["alice", "bob"],
    });
    // Only the Matrix-visible subset received matrix-notify calls.
    expect(matrix.calls).toHaveLength(2);
    expect(matrix.calls.map((c) => c.target).sort()).toEqual(["alice", "bob"]);
  });

  /**
   * Case 9 — independent assertion: threshold satisfying does NOT
   * satisfy recipient_quorum requirement.
   *
   * Three Matrix-visible targets, caller supplies `threshold: {at_least:
   * 3}` but NO `recipient_quorum`. Rejection is
   * `recipient-intent-required` even though threshold would otherwise
   * be satisfiable. Proves the two surfaces are independently asserted
   * (per invariant 4 in design doc §2).
   */
  test("threshold satisfying does NOT satisfy recipient_quorum (independent)", async () => {
    const dispatcher = makeDispatcher({
      agentInboxTool: makeInboxTool(),
      targetDirectory: makeDirectory({
        alice: { matrix: { room: "!a:m" }, inbox: { session: "alice" } },
        bob: { matrix: { room: "!b:m" }, inbox: { session: "bob" } },
        carol: { matrix: { room: "!c:m" }, inbox: { session: "carol" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      {
        targets: ["alice", "bob", "carol"],
        threshold: { at_least: 3 },
        body: "hi",
      },
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("recipient-intent-required");
  });

  /**
   * Case 10 — `recipient_intent.matrix_visible_targets` cross-references
   * PerTargetResult entries by name.
   *
   * Callers can filter results by the intent target names without doing
   * their own visibility detection.
   */
  test("recipient_intent.matrix_visible_targets cross-references PerTargetResult by name", async () => {
    const dispatcher = makeDispatcher({
      agentInboxTool: makeInboxTool(),
      targetDirectory: makeDirectory({
        alice: { matrix: { room: "!a:m" }, inbox: { session: "alice" } },
        bob: { matrix: { room: "!b:m" }, inbox: { session: "bob" } },
        carol: { inbox: { session: "carol" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      {
        targets: ["alice", "bob", "carol"],
        recipient_quorum: { at_least: 2 },
        body: "hi",
      },
      identity(),
    );
    assertFanOut(result);
    const intentTargets = new Set(result.recipient_intent?.matrix_visible_targets);
    const matrixVisibleResults = result.results.filter((r) => intentTargets.has(r.target));
    expect(matrixVisibleResults.map((r) => r.target).sort()).toEqual(["alice", "bob"]);
    // Cross-reference returns the same targets we'd compute manually.
    expect(matrixVisibleResults.every((r) => r.status === "delivered")).toBe(true);
  });

  /**
   * Case 11 — recipient-intent rejection happens BEFORE per-target timer
   * armed.
   *
   * Pre-send rejection means no `setTimeout` was registered for any
   * per-target send (analog to the AJS-63 setTimeout cleanup fix). We
   * verify by setting a very-short target_timeout_ms; if any timer fired
   * we'd see per-target timeout results — instead we get a clean top-level
   * rejection.
   */
  test("recipient-intent rejection fires BEFORE per-target timers arm (no leaked setTimeout)", async () => {
    const matrix = makeMatrixTool();
    const inbox = makeInboxTool();
    const dispatcher = makeDispatcher({
      matrixTool: matrix,
      agentInboxTool: inbox,
      targetDirectory: makeDirectory({
        alice: { matrix: { room: "!a:m" }, inbox: { session: "alice" } },
        bob: { matrix: { room: "!b:m" }, inbox: { session: "bob" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      {
        targets: ["alice", "bob"],
        target_timeout_ms: 1, // would surface as timeout if a timer ever armed
        body: "hi",
      },
      identity(),
    );
    // Pre-send rejection — no per-target results, no in-flight cleanup.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("recipient-intent-required");
    // No matrix or inbox calls — sends never initiated.
    expect(matrix.calls).toHaveLength(0);
    expect(inbox.calls).toHaveLength(0);
    // Wait past the 1ms timeout window to ensure no stray timer fires.
    await new Promise((r) => setTimeout(r, 30));
    expect(matrix.calls).toHaveLength(0);
    expect(inbox.calls).toHaveLength(0);
  });

  /**
   * Additional invariant: recipient_quorum supplied when all targets are
   * inbox-only rejects with recipient-quorum-unsatisfiable (with a
   * not-applicable message hint). Collapses the design-doc §5 edge case
   * into the existing reason rather than introducing a third error.
   */
  test("recipient_quorum supplied with all-inbox targets → recipient-quorum-unsatisfiable", async () => {
    const dispatcher = makeDispatcher({
      agentInboxTool: makeInboxTool(),
      targetDirectory: makeDirectory({
        alice: { inbox: { session: "alice" } },
        bob: { inbox: { session: "bob" } },
      }),
    });
    const result = await dispatcher.sendMessage(
      {
        targets: ["alice", "bob"],
        recipient_quorum: { at_least: 1 },
        body: "hi",
      },
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("recipient-quorum-unsatisfiable");
    expect(result.message).toMatch(/no Matrix-visible targets/i);
  });
});
