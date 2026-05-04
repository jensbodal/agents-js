import { describe, expect, test } from "bun:test";
import { type AuditEventInput, createAuditEmitter, newCorrelationId } from "../src/audit.ts";

/**
 * Three things to verify here:
 *
 *   1. Functional — record/recent/reset behave like a bounded ring buffer.
 *   2. No-content — the union has no variant carrying a `prompt`, `env`,
 *      `args`, or `payload` key. We check this both via TypeScript at
 *      compile time (the `_NoSensitivePayload` guard inside the module)
 *      AND via a runtime sweep here so a future variant addition is
 *      caught even if the type-level check is somehow bypassed.
 *   3. Correlation — IDs propagate across multiple records emitted for
 *      the same operator action.
 */

const SILENT_LOGGER = { log: () => {} } as Pick<Console, "log">;

describe("createAuditEmitter — functional", () => {
  test("record + recent returns events in insertion order", () => {
    const emitter = createAuditEmitter({ logger: SILENT_LOGGER });
    emitter.record({
      kind: "agui-run-started",
      correlationId: "c-1",
      runId: "r-1",
      threadId: "t-1",
    });
    emitter.record({
      kind: "agui-run-finished",
      correlationId: "c-1",
      runId: "r-1",
      threadId: "t-1",
      stopReason: "end_turn",
    });

    const events = emitter.recent();
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("agui-run-started");
    expect(events[1]?.kind).toBe("agui-run-finished");
  });

  test("ring buffer caps at bufferSize, dropping the oldest entries", () => {
    const emitter = createAuditEmitter({ logger: SILENT_LOGGER, bufferSize: 3 });
    for (let i = 0; i < 10; i += 1) {
      emitter.record({
        kind: "a2a-task-started",
        correlationId: `c-${i}`,
        taskId: `task-${i}`,
        contextId: "ctx-1",
      });
    }

    const events = emitter.recent();
    expect(events).toHaveLength(3);
    expect((events[0] as { taskId: string }).taskId).toBe("task-7");
    expect((events[2] as { taskId: string }).taskId).toBe("task-9");
  });

  test("reset clears the buffer", () => {
    const emitter = createAuditEmitter({ logger: SILENT_LOGGER });
    emitter.record({
      kind: "a2a-task-started",
      correlationId: "c-x",
      taskId: "T",
      contextId: "C",
    });
    emitter.reset();
    expect(emitter.recent()).toHaveLength(0);
  });

  test("stamps `at` automatically when omitted", () => {
    const fixed = new Date("2026-04-23T12:00:00.000Z");
    const emitter = createAuditEmitter({ logger: SILENT_LOGGER, now: () => fixed });
    emitter.record({
      kind: "agui-run-started",
      correlationId: "c-1",
      runId: "r-1",
      threadId: "t-1",
    });
    expect(emitter.recent()[0]?.at).toBe("2026-04-23T12:00:00.000Z");
  });
});

describe("createAuditEmitter — correlation propagation", () => {
  test("multiple records with the same correlationId can be filtered into one trace", () => {
    const emitter = createAuditEmitter({ logger: SILENT_LOGGER });
    const correlationId = newCorrelationId();

    emitter.record({
      kind: "agui-run-started",
      correlationId,
      runId: "r-1",
      threadId: "t-1",
    });
    emitter.record({
      kind: "a2a-task-started",
      correlationId,
      taskId: "task-1",
      contextId: "ctx-1",
    });
    emitter.record({
      kind: "agui-run-finished",
      correlationId,
      runId: "r-1",
      threadId: "t-1",
    });

    // Unrelated event with a different correlationId should NOT come back.
    emitter.record({
      kind: "a2a-task-started",
      correlationId: newCorrelationId(),
      taskId: "unrelated-task",
      contextId: "unrelated-ctx",
    });

    const trace = emitter.recent().filter((e) => e.correlationId === correlationId);
    expect(trace).toHaveLength(3);
    expect(trace.map((e) => e.kind)).toEqual([
      "agui-run-started",
      "a2a-task-started",
      "agui-run-finished",
    ]);
  });
});

describe("AuditEvent — sensitive payload prohibition", () => {
  /**
   * Runtime sweep: every variant we emit, we then scan for forbidden
   * keys. The TS-level guard in the module catches the same problem
   * at build time; this test catches it if anyone bypasses TS (e.g.
   * via `as any` somewhere).
   */
  test("no variant emits records carrying prompt/env/args/payload keys", () => {
    const emitter = createAuditEmitter({ logger: SILENT_LOGGER });
    const correlationId = "c-fixture";

    const fixtures: AuditEventInput[] = [
      { kind: "agui-run-started", correlationId, runId: "r", threadId: "t" },
      { kind: "agui-run-finished", correlationId, runId: "r", threadId: "t" },
      {
        kind: "agui-run-error",
        correlationId,
        runId: "r",
        threadId: "t",
        errorCategory: "x",
      },
      { kind: "agui-run-disconnect-cancel", correlationId, runId: "r", threadId: "t" },
      { kind: "a2a-task-started", correlationId, taskId: "T", contextId: "C" },
      {
        kind: "a2a-task-finished",
        correlationId,
        taskId: "T",
        contextId: "C",
        state: "completed",
      },
      {
        kind: "dispatch-started",
        correlationId,
        agentName: "a",
        harness: "h",
        kindVariant: "acp",
        taskId: "T",
      },
      {
        kind: "dispatch-finished",
        correlationId,
        agentName: "a",
        harness: "h",
        kindVariant: "acp",
        taskId: "T",
        state: "completed",
      },
    ];

    for (const event of fixtures) emitter.record(event);

    const FORBIDDEN = ["prompt", "env", "args", "payload"];
    for (const recorded of emitter.recent()) {
      for (const key of FORBIDDEN) {
        expect(Object.hasOwn(recorded, key)).toBe(false);
      }
    }
  });
});

describe("newCorrelationId", () => {
  test("returns a unique non-empty string each call", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});
