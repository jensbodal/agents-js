import { describe, expect, test } from "bun:test";
import type { HarnessCapabilityEntry } from "@agents-js/a2a";
import type { AuditEvent } from "../src/audit.ts";
import { createAuditEmitter } from "../src/audit.ts";
import { createGatewayBus, type GatewayBusEvent } from "../src/gateway-bus.ts";
import {
  type GatewayHarnessCardChangedPayload,
  type GatewayHarnessChildExitedPayload,
  type GatewayHarnessChildSpawnedPayload,
  publishHarnessCardChanged,
  publishHarnessChildExited,
  publishHarnessChildSpawned,
  wrapAuditEmitterAsBusPublisher,
} from "../src/gateway-bus-publishers.ts";

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

// The three `gateway.harness.*` publishers below are thin wrappers
// around `buildGatewayBusEvent` — they exist to keep the topic strings
// and source-principal annotation uniform across the codebase so
// callers in `apps/internal-gateway/main.ts` and the lane manager don't
// duplicate that boilerplate. The tests assert: envelope fields are
// populated, payload round-trips, source principal points at the
// harness, and topic names are stable.

const sampleCapabilities = (): HarnessCapabilityEntry[] => [
  { id: "mock-acp", displayName: "Mock ACP", primary: true, ready: true },
  { id: "opencode", displayName: "OpenCode ACP", primary: false, ready: false },
];

describe("publishHarnessChildSpawned", () => {
  test("publishes an envelope with the correct topic, payload, and harness source principal", () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<GatewayHarnessChildSpawnedPayload>[] = [];
    bus.subscribe((event) =>
      received.push(event as GatewayBusEvent<GatewayHarnessChildSpawnedPayload>),
    );

    const payload: GatewayHarnessChildSpawnedPayload = {
      harnessId: "mock-acp",
      pid: 12345,
      harnessDisplayName: "Mock ACP",
      capabilities: sampleCapabilities(),
    };
    publishHarnessChildSpawned(bus, payload);

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event?.type).toBe("gateway.harness.child-spawned");
    expect(event?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(event?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event?.sourcePrincipal?.kind).toBe("harness");
    expect(event?.sourcePrincipal?.id).toBe("mock-acp");
    expect(event?.payload).toEqual(payload);
    expect(event?.payload.capabilities).toHaveLength(2);
  });

  test("preserves undefined pid in the payload (mock createProcess case)", () => {
    const bus = createGatewayBus();
    let captured: GatewayBusEvent<GatewayHarnessChildSpawnedPayload> | undefined;
    bus.subscribe((event) => {
      captured = event as GatewayBusEvent<GatewayHarnessChildSpawnedPayload>;
    });

    publishHarnessChildSpawned(bus, {
      harnessId: "mock-acp",
      pid: null,
      harnessDisplayName: "Mock ACP",
      capabilities: sampleCapabilities(),
    });

    expect(captured?.payload.pid).toBeNull();
  });
});

describe("publishHarnessChildExited", () => {
  test("publishes with crash: false for gateway-initiated teardown", () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<GatewayHarnessChildExitedPayload>[] = [];
    bus.subscribe((event) =>
      received.push(event as GatewayBusEvent<GatewayHarnessChildExitedPayload>),
    );

    const payload: GatewayHarnessChildExitedPayload = {
      harnessId: "mock-acp",
      pid: 12345,
      exitCode: 0,
      signal: null,
      crash: false,
      durationMs: 1234,
    };
    publishHarnessChildExited(bus, payload);

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event?.type).toBe("gateway.harness.child-exited");
    expect(event?.sourcePrincipal?.kind).toBe("harness");
    expect(event?.sourcePrincipal?.id).toBe("mock-acp");
    expect(event?.payload).toEqual(payload);
    expect(event?.payload.crash).toBe(false);
  });

  test("publishes with crash: true for unexpected exit", () => {
    const bus = createGatewayBus();
    let captured: GatewayBusEvent<GatewayHarnessChildExitedPayload> | undefined;
    bus.subscribe((event) => {
      captured = event as GatewayBusEvent<GatewayHarnessChildExitedPayload>;
    });

    publishHarnessChildExited(bus, {
      harnessId: "opencode",
      pid: 67890,
      exitCode: 1,
      signal: null,
      crash: true,
      durationMs: 42,
    });

    expect(captured?.payload.crash).toBe(true);
    expect(captured?.payload.exitCode).toBe(1);
    expect(captured?.sourcePrincipal?.id).toBe("opencode");
  });

  test("propagates SIGTERM signal in payload", () => {
    const bus = createGatewayBus();
    let captured: GatewayBusEvent<GatewayHarnessChildExitedPayload> | undefined;
    bus.subscribe((event) => {
      captured = event as GatewayBusEvent<GatewayHarnessChildExitedPayload>;
    });

    publishHarnessChildExited(bus, {
      harnessId: "mock-acp",
      pid: 12345,
      exitCode: null,
      signal: "SIGTERM",
      crash: false,
      durationMs: 999,
    });

    expect(captured?.payload.signal).toBe("SIGTERM");
    expect(captured?.payload.exitCode).toBeNull();
  });
});

describe("publishHarnessCardChanged", () => {
  test("publishes envelope with previous + new entry round-tripping", () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<GatewayHarnessCardChangedPayload>[] = [];
    bus.subscribe((event) =>
      received.push(event as GatewayBusEvent<GatewayHarnessCardChangedPayload>),
    );

    const previousEntry: HarnessCapabilityEntry = {
      id: "mock-acp",
      displayName: "Mock ACP",
      primary: true,
      ready: false,
    };
    const newEntry: HarnessCapabilityEntry = {
      id: "mock-acp",
      displayName: "Mock ACP",
      primary: true,
      ready: true,
    };
    publishHarnessCardChanged(bus, {
      harnessId: "mock-acp",
      previousEntry,
      newEntry,
    });

    expect(received).toHaveLength(1);
    const event = received[0];
    expect(event?.type).toBe("gateway.harness.card-changed");
    expect(event?.sourcePrincipal?.kind).toBe("harness");
    expect(event?.sourcePrincipal?.id).toBe("mock-acp");
    expect(event?.payload.previousEntry).toEqual(previousEntry);
    expect(event?.payload.newEntry).toEqual(newEntry);
  });
});

describe("gateway.harness.* topic naming convention", () => {
  test("all three publishers emit topics that start with gateway.harness.", () => {
    const bus = createGatewayBus();
    const topics: string[] = [];
    bus.subscribe((event) => topics.push(event.type));

    publishHarnessChildSpawned(bus, {
      harnessId: "h1",
      pid: 1,
      harnessDisplayName: "H1",
      capabilities: [],
    });
    publishHarnessChildExited(bus, {
      harnessId: "h1",
      pid: 1,
      exitCode: 0,
      signal: null,
      crash: false,
      durationMs: 1,
    });
    publishHarnessCardChanged(bus, {
      harnessId: "h1",
      previousEntry: { id: "h1", displayName: "H1", primary: true, ready: false },
      newEntry: { id: "h1", displayName: "H1", primary: true, ready: true },
    });

    expect(topics).toHaveLength(3);
    for (const topic of topics) {
      expect(topic.startsWith("gateway.harness.")).toBe(true);
    }
    expect(topics).toEqual([
      "gateway.harness.child-spawned",
      "gateway.harness.child-exited",
      "gateway.harness.card-changed",
    ]);
  });
});
