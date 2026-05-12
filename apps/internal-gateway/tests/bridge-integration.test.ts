import { describe, expect, test } from "bun:test";
import {
  buildBridgeBusEvent,
  createBusPublishHandler,
  createBusSubscribeHandler,
  createGatewayBus,
} from "@agents-js/host";
import { composeAdditionalFetch } from "../main.ts";

/**
 * End-to-end external-bridge demo: exercises the full publish path
 * an out-of-process bridge takes against a live gateway.
 *
 * Path under test:
 *   bridge event   →  buildBridgeBusEvent (envelope construction)
 *                  →  POST /admin/publish (bridge → gateway)
 *                  →  bus fan-out
 *                  →  GET /events SSE subscriber
 *                  →  consumer
 *
 * The chain is invoked directly via `composeAdditionalFetch` rather
 * than through `Bun.serve` because PR #51's `bus-endpoint.test.ts`
 * already covers the HTTP transport. What this test asserts is the
 * composition: that the gateway's production wiring routes an
 * external-bridge admin publish to every SSE subscriber unchanged.
 *
 * The fixture payload is intentionally synthetic and not bound to
 * any specific external system. agents-js core does not enumerate
 * sources; this test reflects that — concrete bridge shapes (Matrix,
 * Slack, GitHub) live in their own packages outside core.
 */
describe("internal-gateway: bridge → /admin/publish → SSE integration", () => {
  interface SyntheticBridgePayload {
    source: string;
    sender: string;
    body: string;
  }
  const SYNTHETIC_TOPIC = "gateway.synthetic.event-received";

  test("bridge event posted via /admin/publish reaches /events SSE subscriber", async () => {
    const bus = createGatewayBus();
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
    expect(subscribeResponse?.status).toBe(200);
    const reader = subscribeResponse?.body?.getReader();
    if (!reader) throw new Error("subscribe response has no body reader");

    const bridgePayload: SyntheticBridgePayload = {
      source: "synthetic-bridge",
      sender: "synthetic-author-1",
      body: "bridging external → bus",
    };

    // Build the envelope the same way an out-of-process bridge would,
    // then POST the envelope's body fields to /admin/publish. The
    // endpoint repopulates `id` + `ts` server-side via
    // `buildGatewayBusEvent`, so the bridge's initial id/ts are
    // discarded — only `type`, `payload`, `sourcePrincipal`, and
    // `correlationId` survive.
    const envelopeForBridge = buildBridgeBusEvent<SyntheticBridgePayload>({
      topic: SYNTHETIC_TOPIC,
      payload: bridgePayload,
      sourcePrincipal: { kind: "external-bridge", id: bridgePayload.sender },
      correlationId: "bridge-corr-int",
    });

    const publishResponse = await compose(
      new Request("http://gw.local/admin/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: envelopeForBridge.type,
          payload: envelopeForBridge.payload,
          sourcePrincipal: envelopeForBridge.sourcePrincipal,
          correlationId: envelopeForBridge.correlationId,
        }),
      }),
    );
    expect(publishResponse?.status).toBe(200);

    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const frame = decoder.decode(value);

    expect(frame).toContain("data: ");
    expect(frame).toContain(`"type":"${SYNTHETIC_TOPIC}"`);
    expect(frame).toContain('"correlationId":"bridge-corr-int"');
    expect(frame).toContain('"source":"synthetic-bridge"');
    expect(frame).toContain('"sender":"synthetic-author-1"');
    expect(frame).toContain('"body":"bridging external → bus"');
    expect(frame).toContain(
      '"sourcePrincipal":{"kind":"external-bridge","id":"synthetic-author-1"}',
    );

    await reader.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });

  test("two bridge events from the same sender arrive in publish order with distinct ids", async () => {
    const bus = createGatewayBus();
    const busSubscribeHandler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const busPublishHandler = createBusPublishHandler({ bus });

    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async () => null,
      busSubscribeHandler,
      busPublishHandler,
      syncEndpointHandler: null,
    });

    const reader = (
      await compose(new Request("http://gw.local/events", { method: "GET" }))
    )?.body?.getReader();
    if (!reader) throw new Error("subscribe response has no body reader");

    const basePayload: Omit<SyntheticBridgePayload, "body"> = {
      source: "synthetic-bridge",
      sender: "synthetic-author-1",
    };

    for (const body of ["first", "second"]) {
      const envelope = buildBridgeBusEvent<SyntheticBridgePayload>({
        topic: SYNTHETIC_TOPIC,
        payload: { ...basePayload, body },
        sourcePrincipal: { kind: "external-bridge", id: basePayload.sender },
      });
      await compose(
        new Request("http://gw.local/admin/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: envelope.type,
            payload: envelope.payload,
            sourcePrincipal: envelope.sourcePrincipal,
          }),
        }),
      );
    }

    // Ordering holds because `bus.publish` is synchronous fan-out and
    // the SSE encoder enqueues frames inline. A future async refactor
    // of either layer would need to re-validate this assumption.
    const decoder = new TextDecoder();
    const frame1 = decoder.decode((await reader.read()).value);
    const frame2 = decoder.decode((await reader.read()).value);

    expect(frame1).toContain('"body":"first"');
    expect(frame2).toContain('"body":"second"');

    const id1Match = frame1.match(/^id: ([^\n]+)/m);
    const id2Match = frame2.match(/^id: ([^\n]+)/m);
    expect(id1Match?.[1]).toBeDefined();
    expect(id2Match?.[1]).toBeDefined();
    expect(id1Match?.[1]).not.toBe(id2Match?.[1]);

    await reader.cancel();
  });

  test("subscriber disconnect mid-stream cleans up the bus subscription", async () => {
    // AC v3 edge-case: subscriber disconnect mid-stream must release
    // the bus subscription so we don't leak handlers. PR #51's
    // bus-endpoint tests already cover the cancel() path; this test
    // confirms the live `composeAdditionalFetch` chain preserves
    // that behavior end-to-end.
    const bus = createGatewayBus();
    const busSubscribeHandler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const busPublishHandler = createBusPublishHandler({ bus });

    const compose = composeAdditionalFetch({
      planeWebhookHandler: async () => null,
      aguiHandler: async () => null,
      busSubscribeHandler,
      busPublishHandler,
      syncEndpointHandler: null,
    });

    const reader = (
      await compose(new Request("http://gw.local/events", { method: "GET" }))
    )?.body?.getReader();
    if (!reader) throw new Error("subscribe response has no body reader");

    expect(bus.subscriberCount()).toBe(1);
    await reader.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });
});
