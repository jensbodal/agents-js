import { describe, expect, test } from "bun:test";
import {
  createBusPublishHandler,
  createBusSubscribeHandler,
  createGatewayBus,
} from "@agents-js/host";
import { buildMatrixBusEvent, type MatrixBridgeEventInput } from "@agents-js/matrix-bridge";
import { composeAdditionalFetch } from "../main.ts";

/**
 * Matrix-flavored bridge demo: exercises the same `composeAdditionalFetch`
 * chain as `bridge-integration.test.ts` (the generic primitive test) but
 * uses the {@link buildMatrixBusEvent} wrapper from `@agents-js/matrix-bridge`.
 *
 * The two integration tests serve different concerns:
 *
 * - `bridge-integration.test.ts` — proves the generic
 *   `buildBridgeBusEvent` primitive is wired correctly end-to-end. Uses
 *   a synthetic non-Matrix payload so it can't accidentally exercise
 *   Matrix-specific defaults.
 * - This test — proves the Matrix-specific wrapper layered on top of
 *   the primitive still delivers the end-to-end demo path: one publisher,
 *   one SSE subscriber, full Matrix-event-in / SSE-event-out cycle.
 *   Asserts the Matrix-flavored defaults (source-principal mapped from
 *   sender MXID, canonical `gateway.matrix.event-received` topic) make
 *   it through the chain unchanged.
 *
 * Path under test:
 *   Matrix event   →  buildMatrixBusEvent (envelope construction)
 *                  →  POST /admin/publish (bridge → gateway)
 *                  →  bus fan-out
 *                  →  GET /events SSE subscriber
 *                  →  consumer
 */
describe("internal-gateway: Matrix bridge → /admin/publish → SSE integration", () => {
  test("Matrix event posted via /admin/publish reaches /events SSE subscriber", async () => {
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

    const matrixEvent: MatrixBridgeEventInput = {
      roomId: "!demo:server.example",
      sender: "@alice:server.example",
      type: "m.room.message",
      eventId: "$mxe-1",
      body: "bridging matrix → bus",
      msgtype: "m.text",
    };

    // Build the envelope the same way an out-of-process Matrix
    // bridge would, then POST the envelope's body fields to
    // /admin/publish. The endpoint repopulates `id` + `ts`
    // server-side via `buildGatewayBusEvent`, so the bridge's
    // initial id/ts are discarded — only `type`, `payload`,
    // `sourcePrincipal`, `correlationId` survive.
    const envelopeForBridge = buildMatrixBusEvent({
      matrixEvent,
      correlationId: "mxe-corr-int",
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
    expect(frame).toContain('"type":"gateway.matrix.event-received"');
    expect(frame).toContain('"correlationId":"mxe-corr-int"');
    expect(frame).toContain('"roomId":"!demo:server.example"');
    expect(frame).toContain('"sender":"@alice:server.example"');
    expect(frame).toContain('"body":"bridging matrix → bus"');
    expect(frame).toContain('"sourcePrincipal":{"kind":"matrix","id":"@alice:server.example"}');

    await reader.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });

  test("two Matrix events from the same sender arrive in publish order with distinct ids", async () => {
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

    const matrixEvent: Omit<MatrixBridgeEventInput, "body" | "eventId"> = {
      roomId: "!ordering:server.example",
      sender: "@alice:server.example",
      type: "m.room.message",
      msgtype: "m.text",
    };

    for (const body of ["first", "second"]) {
      const envelope = buildMatrixBusEvent({
        matrixEvent: { ...matrixEvent, body, eventId: `$mxe-${body}` },
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
});
