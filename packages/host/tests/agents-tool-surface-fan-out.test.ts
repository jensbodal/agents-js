/**
 * AJS-63 multi-recipient fan-out + threshold/quorum contract.
 *
 * Pins the 10 behavior cases from the vault design doc
 * (`agents-js-send-message-fan-out-quorum-2026-05-23.md`):
 *
 *   1. Single-target back-compat (unchanged shape)
 *   2. Multi-target all-success
 *   3. Multi-target all-fail
 *   4. Threshold met partial (with early_return)
 *   5. Threshold not met (waits for all terminal)
 *   6. Scope violation on one of N
 *   7. Empty targets rejection
 *   8. Duplicate targets rejection
 *   9. Fan-out cap exceeded rejection
 *  10. Per-target timeout
 *
 * Plus a few additional invariants surfaced during implementation:
 *   - `target` + `targets` mutually exclusive
 *   - `threshold` rejected on single-target calls
 *   - early_return: false waits for all terminal even after threshold met
 */

import { describe, expect, test } from "bun:test";
import {
  type AgentInboxTool,
  type AgentsDispatcher,
  createAgentsDispatcher,
  FAN_OUT_TARGET_CAP,
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
    correlationId: opts.correlationId ?? "cid-fan-out-001",
    issuer: opts.issuer ?? "test",
    expiresAt: opts.expiresAt ?? Math.floor(Date.now() / 1000) + 900,
  };
}

function makeDirectory(
  entries: Record<string, { matrix?: { room: string }; inbox?: { session: string } }>,
): TargetDirectory {
  return {
    resolve(target) {
      return entries[target] ?? null;
    },
  };
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

interface InboxToolWithCalls extends AgentInboxTool {
  calls: Array<{ toSession: string; body: string }>;
}

function makeInboxTool(
  overrides: {
    deliver?: (args: {
      toSession: string;
      body: string;
    }) => Promise<{ message_id: string; created_at: string }>;
  } = {},
): InboxToolWithCalls {
  const calls: Array<{ toSession: string; body: string }> = [];
  let n = 0;
  return {
    calls,
    async deliver({ toSession, body }) {
      calls.push({ toSession, body });
      if (overrides.deliver) {
        return overrides.deliver({ toSession, body });
      }
      n += 1;
      return { message_id: `msg-${n}`, created_at: new Date(0).toISOString() };
    },
    async read() {
      return [];
    },
  };
}

function makeDispatcher(
  opts: {
    matrixTool?: MatrixTool;
    agentInboxTool?: AgentInboxTool;
    targetDirectory?: TargetDirectory;
  } = {},
): AgentsDispatcher {
  return createAgentsDispatcher({
    matrixTool: opts.matrixTool ?? makeMatrixTool(),
    ...(opts.agentInboxTool ? { agentInboxTool: opts.agentInboxTool } : {}),
    targetDirectory:
      opts.targetDirectory ??
      makeDirectory({
        a: { inbox: { session: "a" } },
        b: { inbox: { session: "b" } },
        c: { inbox: { session: "c" } },
      }),
  });
}

function assertFanOut(
  result: SendMessageResult,
): asserts result is Extract<SendMessageResult, { results: unknown }> {
  if (!isFanOutSendResult(result)) {
    throw new Error(`expected fan-out result; got ${JSON.stringify(result)}`);
  }
}

describe("packages/host/tests/agents-tool-surface-fan-out.test.ts — AJS-63 contract", () => {
  /**
   * Case 1 (vault doc) — single-target back-compat.
   *
   * The pre-AJS-63 call shape (single `target: string`) must produce the
   * pre-AJS-63 result shape (top-level inbox_message_id / event_id, no
   * `results` field). Critical for any consumer still on the single-target
   * surface; broken back-compat here would silently break the entire
   * existing tool consumer base.
   */
  test("single-target call returns back-compat shape (no `results` field)", async () => {
    const inbox = makeInboxTool();
    const dispatcher = makeDispatcher({ agentInboxTool: inbox });
    const result = await dispatcher.sendMessage({ target: "a", body: "hi" }, identity());
    expect(result.ok).toBe(true);
    expect(isFanOutSendResult(result)).toBe(false);
    if (!result.ok || isFanOutSendResult(result)) throw new Error();
    expect(result.inbox_message_id).toBe("msg-1");
    expect(inbox.calls).toHaveLength(1);
    expect(inbox.calls[0]?.toSession).toBe("a");
  });

  /**
   * Case 2 — multi-target all-success.
   *
   * Three targets, three terminal `delivered` results, threshold_met true
   * (default threshold = targets.length). Each target's inbox-write is
   * called independently.
   */
  test("all targets succeed → delivered=N, failed=0, threshold_met=true", async () => {
    const inbox = makeInboxTool();
    const dispatcher = makeDispatcher({ agentInboxTool: inbox });
    const result = await dispatcher.sendMessage(
      { targets: ["a", "b", "c"], body: "hi" },
      identity(),
    );
    assertFanOut(result);
    expect(result.delivered).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.in_flight).toBe(0);
    expect(result.threshold_met).toBe(true);
    expect(result.results.map((r) => r.status)).toEqual(["delivered", "delivered", "delivered"]);
    // Per-target inbox ids surface in PerTargetResult, NOT at the top level.
    expect(result.results.every((r) => typeof r.inbox_message_id === "string")).toBe(true);
    expect(inbox.calls.map((c) => c.toSession).sort()).toEqual(["a", "b", "c"]);
  });

  /**
   * Case 3 — multi-target all-fail.
   *
   * Inbox throws for every target → three `failed` results,
   * threshold_met false. Confirms per-target failure isolation (one
   * target's error never throws out of the dispatcher).
   */
  test("all targets fail (inbox throws) → delivered=0, failed=N, threshold_met=false", async () => {
    const inbox = makeInboxTool({
      deliver: async () => {
        throw new Error("storage corrupted");
      },
    });
    const dispatcher = makeDispatcher({ agentInboxTool: inbox });
    const result = await dispatcher.sendMessage(
      { targets: ["a", "b", "c"], body: "hi" },
      identity(),
    );
    assertFanOut(result);
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.threshold_met).toBe(false);
    expect(result.results.every((r) => r.status === "failed")).toBe(true);
    expect(result.results.every((r) => r.error === "inbox-write-failed")).toBe(true);
  });

  /**
   * Case 4 — threshold met partial (early_return default).
   *
   * Threshold {at_least: 2} of 3 targets. Two succeed, one is slow. With
   * default early_return=true the call returns when threshold is met
   * without waiting for the slow target. The slow target may appear in
   * results with status "delivered" (raced ahead of return) or may be
   * absent (in_flight). Either is correct per the contract; we assert
   * the aggregate invariant.
   */
  test("threshold met partial with early_return=true → returns when threshold met", async () => {
    const slow = makeInboxTool({
      deliver: async ({ toSession }) => {
        if (toSession === "c") {
          await new Promise((r) => setTimeout(r, 200));
        }
        return { message_id: `msg-${toSession}`, created_at: new Date(0).toISOString() };
      },
    });
    const dispatcher = makeDispatcher({ agentInboxTool: slow });
    const t0 = Date.now();
    const result = await dispatcher.sendMessage(
      { targets: ["a", "b", "c"], threshold: { at_least: 2 }, body: "hi" },
      identity(),
    );
    const elapsed = Date.now() - t0;
    assertFanOut(result);
    // Threshold met means we return as soon as a + b deliver — well before
    // c's 200ms timer fires. With reasonable scheduler slack, < 150ms.
    expect(elapsed).toBeLessThan(180);
    expect(result.threshold_met).toBe(true);
    expect(result.delivered).toBeGreaterThanOrEqual(2);
    // c may be in_flight OR may have raced ahead — both shapes are valid.
    expect(result.delivered + result.in_flight).toBeGreaterThanOrEqual(2);
    expect(result.delivered + result.failed + result.in_flight).toBe(3);
  });

  /**
   * Case 5 — threshold not met (remaining-targets short-circuit).
   *
   * Threshold {at_least: 3} of 3, but `b` and `c` fail. After their
   * failures the dispatcher knows threshold cannot possibly be met
   * (remaining + delivered < at_least) and returns early.
   */
  test("threshold not met short-circuits when remaining cannot satisfy", async () => {
    const inbox = makeInboxTool({
      deliver: async ({ toSession }) => {
        if (toSession === "a") {
          return { message_id: "msg-a", created_at: new Date(0).toISOString() };
        }
        throw new Error("storage corrupted");
      },
    });
    const dispatcher = makeDispatcher({ agentInboxTool: inbox });
    const result = await dispatcher.sendMessage(
      { targets: ["a", "b", "c"], threshold: { at_least: 3 }, body: "hi" },
      identity(),
    );
    assertFanOut(result);
    expect(result.threshold_met).toBe(false);
    // After `a` delivers and `b` fails, the short-circuit fires:
    // stillReachable (1 delivered + 1 in-flight) < threshold (3). `c`
    // may still be in-flight when we return — the discarded result is the
    // tradeoff for early-return semantics. The aggregate invariant holds:
    // every counted slot is accounted for.
    expect(result.delivered + result.failed + result.in_flight).toBe(3);
    expect(result.delivered).toBe(1);
  });

  /**
   * Case 6 — unroutable target among N.
   *
   * Caller has inbox.deliver scope; `a` + `b` have inbox routes and
   * deliver, but `c` is not in the directory. The call delivers to
   * `a` + `b` and fails for `c` with unknown-target.
   */
  test("unroutable target among N → that target fails, others succeed", async () => {
    const inbox = makeInboxTool();
    const dispatcher = makeDispatcher({
      agentInboxTool: inbox,
      targetDirectory: makeDirectory({
        a: { inbox: { session: "a" } },
        b: { inbox: { session: "b" } },
        // `c` deliberately absent from the directory.
      }),
    });
    const result = await dispatcher.sendMessage(
      { targets: ["a", "b", "c"], body: "hi" },
      identity({ scopes: ["inbox.deliver"] }),
    );
    assertFanOut(result);
    expect(result.delivered).toBe(2);
    expect(result.failed).toBe(1);
    const cResult = result.results.find((r) => r.target === "c");
    expect(cResult?.status).toBe("failed");
    expect(cResult?.error).toBe("unknown-target");
  });

  /**
   * Case 7 — empty targets rejected.
   *
   * `targets: []` → top-level invalid-args. Vacuous success would be
   * ambiguous (delivered=0 with threshold_met=true is meaningless).
   */
  test("empty targets array → invalid-args", async () => {
    const dispatcher = makeDispatcher({ agentInboxTool: makeInboxTool() });
    const result = await dispatcher.sendMessage({ targets: [], body: "hi" }, identity());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("invalid-args");
  });

  /**
   * Case 8 — duplicate targets rejected.
   *
   * Duplicates in `targets` reject loudly rather than silently dedupe.
   * Per-target results would otherwise be ambiguous (which "a" entry is
   * which).
   */
  test("duplicate targets → invalid-args", async () => {
    const dispatcher = makeDispatcher({ agentInboxTool: makeInboxTool() });
    const result = await dispatcher.sendMessage(
      { targets: ["a", "a", "b"], body: "hi" },
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("invalid-args");
    expect(result.message).toMatch(/duplicate/i);
  });

  /**
   * Case 9 — fan-out cap exceeded rejected.
   *
   * DoS bound surfaces as invalid-args with the cap in the message so
   * callers can adjust their batch size.
   */
  test("targets exceeds FAN_OUT_TARGET_CAP → invalid-args with cap surfaced", async () => {
    const dispatcher = makeDispatcher({ agentInboxTool: makeInboxTool() });
    const many = Array.from({ length: FAN_OUT_TARGET_CAP + 1 }, (_, i) => `t-${i}`);
    const result = await dispatcher.sendMessage({ targets: many, body: "hi" }, identity());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("invalid-args");
    expect(result.message).toMatch(new RegExp(`fan-out cap of ${FAN_OUT_TARGET_CAP}`));
  });

  /**
   * Case 10 — per-target timeout.
   *
   * Slow target whose inbox.deliver never returns within target_timeout_ms
   * surfaces with status: "timeout". Distinguished from "failed" so callers
   * can detect dead-peer vs explicit-NACK shapes.
   */
  test("per-target timeout → status: 'timeout' for slow target", async () => {
    const inbox = makeInboxTool({
      deliver: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return { message_id: "never", created_at: new Date(0).toISOString() };
      },
    });
    const dispatcher = makeDispatcher({ agentInboxTool: inbox });
    const result = await dispatcher.sendMessage(
      { targets: ["a"], target_timeout_ms: 50, body: "hi" },
      identity(),
    );
    assertFanOut(result);
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0]?.status).toBe("timeout");
    expect(result.results[0]?.error).toBe("timeout");
  });

  /**
   * Additional invariant: `target` and `targets` are mutually exclusive.
   */
  test("both `target` and `targets` set → invalid-args", async () => {
    const dispatcher = makeDispatcher({ agentInboxTool: makeInboxTool() });
    // The TS shape technically allows both fields (the `[extraField: string]: unknown`
    // index signature makes them coexist at the type level) — the runtime guard is
    // the load-bearing protection here.
    const result = await dispatcher.sendMessage(
      { target: "a", targets: ["a", "b"], body: "hi" },
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("invalid-args");
    expect(result.message).toMatch(/mutually exclusive/i);
  });

  /**
   * Additional invariant: `threshold` is multi-target only.
   */
  test("`threshold` set on single-target call → invalid-args", async () => {
    const dispatcher = makeDispatcher({ agentInboxTool: makeInboxTool() });
    const result = await dispatcher.sendMessage(
      { target: "a", threshold: { at_least: 1 }, body: "hi" },
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("invalid-args");
    expect(result.message).toMatch(/multi-target/i);
  });

  /**
   * Additional invariant: `early_return: false` waits for all terminal
   * even after threshold met.
   */
  test("early_return:false waits for all terminal even after threshold met", async () => {
    const slow = makeInboxTool({
      deliver: async ({ toSession }) => {
        if (toSession === "c") {
          await new Promise((r) => setTimeout(r, 80));
        }
        return { message_id: `msg-${toSession}`, created_at: new Date(0).toISOString() };
      },
    });
    const dispatcher = makeDispatcher({ agentInboxTool: slow });
    const result = await dispatcher.sendMessage(
      {
        targets: ["a", "b", "c"],
        threshold: { at_least: 2 },
        early_return: false,
        body: "hi",
      },
      identity(),
    );
    assertFanOut(result);
    expect(result.delivered).toBe(3);
    expect(result.in_flight).toBe(0);
    expect(result.results).toHaveLength(3);
  });

  /**
   * Additional invariant: `threshold.at_least > targets.length` rejected.
   *
   * Unsatisfiable threshold should fail-fast at validation rather than
   * always returning threshold_met=false.
   */
  test("threshold.at_least > targets.length → invalid-args", async () => {
    const dispatcher = makeDispatcher({ agentInboxTool: makeInboxTool() });
    const result = await dispatcher.sendMessage(
      { targets: ["a", "b"], threshold: { at_least: 3 }, body: "hi" },
      identity(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error).toBe("invalid-args");
  });
});
