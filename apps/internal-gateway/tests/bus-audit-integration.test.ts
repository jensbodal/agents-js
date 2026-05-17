import { describe, expect, test } from "bun:test";
import {
  createAuditEmitter,
  createBusPublishHandler,
  createBusSubscribeHandler,
  createGatewayBus,
  wrapAuditEmitterAsBusPublisher,
} from "@agents-js/host";
import { composeAdditionalFetch } from "../main.ts";

/**
 * End-to-end integration: a real gateway audit event reaches a bus
 * subscriber via the same wiring `main.ts` uses in production.
 *
 * Shipping `wrapAuditEmitterAsBusPublisher` as a defined-but-unused
 * helper does not establish that audit events actually reach bus
 * subscribers — the wrapper has to be live in the production runtime
 * path. This test exercises that live path:
 * the exact `composeAdditionalFetch` chain main.ts assembles, the
 * exact audit-emitter shape main.ts constructs, and a real SSE
 * subscriber reading the bus through the chain.
 *
 * The chain is invoked directly rather than through `Bun.serve`
 * because the `createBusSubscribeHandler` unit tests already cover
 * the HTTP transport — what we want to assert here is the
 * composition, not the wire format.
 */
describe("internal-gateway: audit-emitter → bus → SSE integration", () => {
  test("audit event recorded via wrapped emitter reaches /events SSE subscriber", async () => {
    const bus = createGatewayBus();
    const audit = wrapAuditEmitterAsBusPublisher({
      bus,
      emitter: createAuditEmitter({ logger: { log() {} } }),
    });
    const busSubscribeHandler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const busPublishHandler = createBusPublishHandler({ bus });

    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async () => null,
      busSubscribeHandler,
      busPublishHandler,
      syncEndpointHandler: null,
    });

    const subscribeResponse = await compose(
      new Request("http://gw.local/events", { method: "GET" }),
    );
    expect(subscribeResponse).not.toBeNull();
    expect(subscribeResponse?.status).toBe(200);
    expect(subscribeResponse?.headers.get("content-type")).toContain("text/event-stream");

    const reader = subscribeResponse?.body?.getReader();
    if (!reader) throw new Error("subscribe response has no body reader");

    // Fire a gateway audit event through the wrapped emitter — same
    // call shape as e.g. host-executor's `this.audit?.record({...})`
    // in production. We use a stable correlation id so we can verify
    // it propagates to the SSE envelope.
    audit.record({
      kind: "a2a-task-started",
      correlationId: "integration-corr-1",
      taskId: "task-int-1",
      contextId: "ctx-int-1",
    });

    // First SSE frame should be the audit envelope.
    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const frame = decoder.decode(value);

    expect(frame).toContain("data: ");
    expect(frame).toContain('"type":"gateway.audit.a2a-task-started"');
    expect(frame).toContain('"correlationId":"integration-corr-1"');
    expect(frame).toContain('"taskId":"task-int-1"');
    expect(frame).toContain('"contextId":"ctx-int-1"');

    await reader.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });

  test("publish endpoint and audit publisher feed the same subscriber", async () => {
    // Verifies the wiring lets BOTH publisher paths (audit-wrapper +
    // admin /publish HTTP endpoint) reach a single SSE subscriber.
    const bus = createGatewayBus();
    const audit = wrapAuditEmitterAsBusPublisher({
      bus,
      emitter: createAuditEmitter({ logger: { log() {} } }),
    });
    const busSubscribeHandler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const busPublishHandler = createBusPublishHandler({ bus });

    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async () => null,
      busSubscribeHandler,
      busPublishHandler,
      syncEndpointHandler: null,
    });

    const subscribeResponse = await compose(
      new Request("http://gw.local/events", { method: "GET" }),
    );
    const reader = subscribeResponse?.body?.getReader();
    if (!reader) throw new Error("subscribe response has no body reader");

    // Emit via the audit publisher.
    audit.record({
      kind: "mention-dispatch-started",
      correlationId: "mixed-corr",
      agentName: "test-agent",
    });

    // Emit via the admin publish endpoint.
    await compose(
      new Request("http://gw.local/admin/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "gateway.matrix.event-received",
          payload: { roomId: "!demo:server", body: "hello" },
          correlationId: "mixed-corr",
        }),
      }),
    );

    const decoder = new TextDecoder();
    const f1 = decoder.decode((await reader.read()).value);
    const f2 = decoder.decode((await reader.read()).value);

    expect(f1).toContain('"type":"gateway.audit.mention-dispatch-started"');
    expect(f2).toContain('"type":"gateway.matrix.event-received"');

    await reader.cancel();
  });
});
