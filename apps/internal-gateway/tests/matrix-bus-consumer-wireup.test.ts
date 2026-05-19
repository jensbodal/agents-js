/**
 * Wire-up integration test for the Matrix bus consumer installed by
 * internal-gateway/main.ts (E4.0-b infrastructure-install commit).
 *
 * This test does NOT spin up the full gateway — it exercises the
 * specific install pattern: a consumer subscribed to the bus, a
 * placeholder dispatch handler that returns `consumer-unreachable`
 * failures, and the resulting reply event emitted back through the bus.
 *
 * When the follow-up "real dispatch" commit replaces the placeholder
 * with a HostA2AExecutor-backed handler, these tests pivot to
 * exercising the round-trip (`@@target` → executor → reply with
 * `success`). The placeholder-failure assertions document the
 * intermediate state.
 *
 * Per ADR 0002 surface-3 transport-invariance: the install pattern is
 * verified here independently of which dispatch handler is plugged in.
 * The consumer's `failureReason: "consumer-unreachable"` is the DOT-393
 * Phase B fallback signal that out-of-process bridges use to fall back
 * to direct HTTP A2A.
 */

import { describe, expect, test } from "bun:test";
import {
  createGatewayBus,
  type DispatchHandler,
  type DispatchResult,
  type GatewayBusEvent,
  MATRIX_INBOUND_TOPIC,
  MATRIX_REPLY_TOPIC,
  type MatrixBusReplyPayload,
  startMatrixBusConsumer,
} from "@agents-js/host";

describe("internal-gateway matrix-bus-consumer wire-up", () => {
  test("placeholder dispatch returns consumer-unreachable failure on inbound event", async () => {
    const bus = createGatewayBus();
    const replies: GatewayBusEvent<MatrixBusReplyPayload>[] = [];
    bus.subscribe((event) => {
      if (event.type === MATRIX_REPLY_TOPIC) {
        replies.push(event as GatewayBusEvent<MatrixBusReplyPayload>);
      }
    });

    // Mirror the exact install shape used in main.ts: placeholder
    // dispatch that emits a consumer-unreachable failure so the bridge
    // can fall back to direct HTTP A2A per DOT-393 Phase B.
    const placeholderDispatch: DispatchHandler = async () => {
      const result: DispatchResult = {
        status: "failure",
        body: "matrix-bus-consumer dispatch handler not yet wired (placeholder); bridge should fall back to direct HTTP A2A per DOT-393 Phase B",
        failureReason: "consumer-unreachable",
      };
      return result;
    };
    const consumer = startMatrixBusConsumer({ bus, dispatch: placeholderDispatch });

    bus.publish({
      id: "evt-wire-1",
      type: MATRIX_INBOUND_TOPIC,
      ts: new Date().toISOString(),
      payload: {
        roomId: "!room:example.org",
        sender: "@alice:example.org",
        type: "m.room.message",
        eventId: "$evt-wire-1",
        body: "@@target hello",
        msgtype: "m.text",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replies.length).toBe(1);
    const reply = replies[0];
    if (reply === undefined) throw new Error("no reply emitted");
    expect(reply.payload.kind).toBe("failure");
    expect(reply.payload.failureReason).toBe("consumer-unreachable");
    expect(reply.payload.roomId).toBe("!room:example.org");
    expect(reply.payload.inReplyToEventId).toBe("$evt-wire-1");
    consumer.stop();
  });

  test("consumer.stop() makes subsequent inbound events no-ops (shutdown cleanliness)", async () => {
    const bus = createGatewayBus();
    let invoked = 0;
    const consumer = startMatrixBusConsumer({
      bus,
      dispatch: async () => {
        invoked++;
        return {
          status: "failure",
          body: "placeholder",
          failureReason: "consumer-unreachable",
        };
      },
    });
    consumer.stop();

    bus.publish({
      id: "evt-after-stop",
      type: MATRIX_INBOUND_TOPIC,
      ts: new Date().toISOString(),
      payload: {
        roomId: "!room:example.org",
        sender: "@alice:example.org",
        type: "m.room.message",
        body: "@@target after stop",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoked).toBe(0);
  });
});

// Follow-up commit (test.todo): once the placeholder dispatch is
// replaced with a real HostA2AExecutor binding, these tests should
// flip from asserting `failureReason: "consumer-unreachable"` to
// asserting end-to-end round-trips through the executor with
// `kind: "success"`.
describe("E4.0-b follow-up — real dispatch wiring (test.todo)", () => {
  test.todo("@@target dispatch invokes the gateway's primary harness lane controller", () => {});
  test.todo("dispatch reply carries the target ACP runtime's response verbatim", () => {});
  test.todo("dispatch error from the executor surfaces as failureReason='dispatch-error' (not consumer-unreachable)", () => {});
});
