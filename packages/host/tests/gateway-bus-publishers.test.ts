import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "../src/audit.ts";
import { createAuditEmitter } from "../src/audit.ts";
import { createGatewayBus, type GatewayBusEvent } from "../src/gateway-bus.ts";
import { wrapAuditEmitterAsBusPublisher } from "../src/gateway-bus-publishers.ts";

// `wrapAuditEmitterAsBusPublisher` lifts an existing AuditEmitter into a
// bus publisher: every recorded audit event becomes a
// `gateway.audit.<kind>` bus event. The wrapped emitter preserves the
// `AuditEmitter` shape so callers swap it in at construction without
// any other API changes.

describe("wrapAuditEmitterAsBusPublisher", () => {
  test("delegates record + publishes on the bus", () => {
    const bus = createGatewayBus();
    const base = createAuditEmitter({ logger: { log() {} } });
    const received: GatewayBusEvent<AuditEvent>[] = [];
    bus.subscribe((event) => received.push(event as GatewayBusEvent<AuditEvent>));

    const wrapped = wrapAuditEmitterAsBusPublisher({ bus, emitter: base });
    wrapped.record({
      kind: "agui-run-started",
      correlationId: "corr-1",
      runId: "run-a",
      threadId: "thread-a",
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("gateway.audit.agui-run-started");
    expect(received[0]?.correlationId).toBe("corr-1");
    expect(received[0]?.payload.kind).toBe("agui-run-started");
    expect((received[0]?.payload as { runId?: string }).runId).toBe("run-a");
  });

  test("propagates the stamped `at` timestamp from the underlying emitter", () => {
    const bus = createGatewayBus();
    // Inject a deterministic clock so we can assert the timestamp shape.
    const fixedNow = new Date("2026-05-11T12:34:56.789Z");
    const base = createAuditEmitter({
      logger: { log() {} },
      now: () => fixedNow,
    });
    let captured: GatewayBusEvent<AuditEvent> | undefined;
    bus.subscribe((event) => {
      captured = event as GatewayBusEvent<AuditEvent>;
    });

    const wrapped = wrapAuditEmitterAsBusPublisher({ bus, emitter: base });
    wrapped.record({
      kind: "a2a-task-started",
      correlationId: "corr-ts",
      taskId: "task-a",
      contextId: "ctx-a",
    });

    expect(captured).toBeDefined();
    expect(captured?.payload.at).toBe(fixedNow.toISOString());
  });

  test("delegates `recent` to the underlying emitter", () => {
    const bus = createGatewayBus();
    const base = createAuditEmitter({ logger: { log() {} } });
    const wrapped = wrapAuditEmitterAsBusPublisher({ bus, emitter: base });

    wrapped.record({
      kind: "agui-run-started",
      correlationId: "c1",
      runId: "r1",
      threadId: "t1",
    });
    wrapped.record({
      kind: "agui-run-finished",
      correlationId: "c1",
      runId: "r1",
      threadId: "t1",
    });

    const recent = wrapped.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0]?.kind).toBe("agui-run-started");
    expect(recent[1]?.kind).toBe("agui-run-finished");
  });

  test("delegates `reset` to the underlying emitter", () => {
    const bus = createGatewayBus();
    const base = createAuditEmitter({ logger: { log() {} } });
    const wrapped = wrapAuditEmitterAsBusPublisher({ bus, emitter: base });

    wrapped.record({
      kind: "agui-run-started",
      correlationId: "c1",
      runId: "r1",
      threadId: "t1",
    });
    expect(wrapped.recent()).toHaveLength(1);

    wrapped.reset();
    expect(wrapped.recent()).toHaveLength(0);
  });

  test("applies the default `gateway-audit-publisher` source principal when none is provided", () => {
    const bus = createGatewayBus();
    const base = createAuditEmitter({ logger: { log() {} } });
    let captured: GatewayBusEvent<unknown> | undefined;
    bus.subscribe((event) => {
      captured = event;
    });

    const wrapped = wrapAuditEmitterAsBusPublisher({ bus, emitter: base });
    wrapped.record({
      kind: "registry-sync-served",
      correlationId: "c2",
      path: "/test",
      recordCount: 1,
      totalRecordCount: 1,
    });

    expect(captured?.sourcePrincipal?.kind).toBe("workload");
    expect(captured?.sourcePrincipal?.id).toBe("gateway-audit-publisher");
  });

  test("respects a caller-supplied source principal", () => {
    const bus = createGatewayBus();
    const base = createAuditEmitter({ logger: { log() {} } });
    let captured: GatewayBusEvent<unknown> | undefined;
    bus.subscribe((event) => {
      captured = event;
    });

    const wrapped = wrapAuditEmitterAsBusPublisher({
      bus,
      emitter: base,
      sourcePrincipal: { kind: "test", id: "test-audit-publisher" },
    });
    wrapped.record({
      kind: "agui-run-started",
      correlationId: "c3",
      runId: "r3",
      threadId: "t3",
    });

    expect(captured?.sourcePrincipal?.kind).toBe("test");
    expect(captured?.sourcePrincipal?.id).toBe("test-audit-publisher");
  });

  test("publishes multiple events when record is called multiple times", () => {
    const bus = createGatewayBus();
    const base = createAuditEmitter({ logger: { log() {} } });
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const wrapped = wrapAuditEmitterAsBusPublisher({ bus, emitter: base });
    wrapped.record({
      kind: "agui-run-started",
      correlationId: "x",
      runId: "r",
      threadId: "t",
    });
    wrapped.record({
      kind: "agui-run-finished",
      correlationId: "x",
      runId: "r",
      threadId: "t",
    });
    wrapped.record({
      kind: "mention-dispatch-started",
      correlationId: "y",
      agentName: "test-agent",
    });

    expect(received).toHaveLength(3);
    expect(received[0]?.type).toBe("gateway.audit.agui-run-started");
    expect(received[1]?.type).toBe("gateway.audit.agui-run-finished");
    expect(received[2]?.type).toBe("gateway.audit.mention-dispatch-started");
  });

  test("each published event has a unique id even when correlationId is shared", () => {
    const bus = createGatewayBus();
    const base = createAuditEmitter({ logger: { log() {} } });
    const ids = new Set<string>();
    bus.subscribe((event) => ids.add(event.id));

    const wrapped = wrapAuditEmitterAsBusPublisher({ bus, emitter: base });
    for (let i = 0; i < 5; i++) {
      wrapped.record({
        kind: "agui-run-started",
        correlationId: "same-correlation",
        runId: `run-${i}`,
        threadId: "t",
      });
    }
    expect(ids.size).toBe(5);
  });

  test("publishes even when the underlying emitter has bufferSize: 0", () => {
    // Regression test for the silent-drop bug: previously the wrapper
    // read `emitter.recent(1)` to get the stamped event, which returned
    // empty whenever the ring buffer was configured to drop on push.
    // The wrapper now consumes `record()`'s return value directly so
    // the bus publish runs regardless of buffer retention.
    const bus = createGatewayBus();
    const base = createAuditEmitter({ logger: { log() {} }, bufferSize: 0 });
    const received: GatewayBusEvent<AuditEvent>[] = [];
    bus.subscribe((event) => received.push(event as GatewayBusEvent<AuditEvent>));

    const wrapped = wrapAuditEmitterAsBusPublisher({ bus, emitter: base });
    wrapped.record({
      kind: "agui-run-started",
      correlationId: "buffer-zero",
      runId: "run-bz",
      threadId: "t-bz",
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("gateway.audit.agui-run-started");
    // The underlying emitter still drops on push — that's its
    // configured behavior — but the wrapper's publish path is unaffected.
    expect(wrapped.recent()).toHaveLength(0);
  });

  test("returns the stamped event from record() so callers can chain on it", () => {
    const bus = createGatewayBus();
    const base = createAuditEmitter({ logger: { log() {} } });
    const wrapped = wrapAuditEmitterAsBusPublisher({ bus, emitter: base });

    const stamped = wrapped.record({
      kind: "a2a-task-finished",
      correlationId: "ret",
      taskId: "task-ret",
      contextId: "ctx-ret",
      state: "completed",
    });

    expect(stamped.kind).toBe("a2a-task-finished");
    expect(stamped.correlationId).toBe("ret");
    expect(stamped.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
