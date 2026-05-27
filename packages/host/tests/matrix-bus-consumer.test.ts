/**
 * Conformance tests for the Matrix bus consumer (E4.0-b skeleton).
 *
 * These tests pin the contract surface from ADR 0002 (public inbound
 * transport abstraction): the consumer subscribes to the inbound
 * topic, parses dispatch directives, invokes the supplied handler,
 * and publishes a typed reply event. Implementation wiring (binding
 * the dispatch handler to the gateway's A2A endpoint, hooking the
 * consumer into internal-gateway startup) is follow-up work; this
 * file documents the contract the consumer must satisfy.
 */

import { describe, expect, test } from "bun:test";
import { createGatewayBus, type GatewayBusEvent } from "../src/gateway-bus.ts";
import {
  type DispatchRequest,
  MATRIX_INBOUND_TOPIC,
  MATRIX_REPLY_TOPIC,
  type MatrixBusEventPayload,
  type MatrixBusReplyPayload,
  parseDispatchDirective,
  startMatrixBusConsumer,
} from "../src/matrix-bus-consumer.ts";

const sampleMatrixEvent = (
  overrides: Partial<MatrixBusEventPayload> = {},
): MatrixBusEventPayload => ({
  roomId: "!room:example.org",
  sender: "@alice:example.org",
  type: "m.room.message",
  eventId: "$evt1",
  body: "hello world",
  msgtype: "m.text",
  ...overrides,
});

describe("parseDispatchDirective", () => {
  test("empty body returns empty target and empty message", () => {
    expect(parseDispatchDirective("")).toEqual({ target: "", message: "" });
  });

  test("body without @@ prefix returns empty target and body verbatim as message", () => {
    expect(parseDispatchDirective("hello world")).toEqual({
      target: "",
      message: "hello world",
    });
  });

  test("`@@target message` parses target and message", () => {
    expect(parseDispatchDirective("@@cognee-claude ping")).toEqual({
      target: "cognee-claude",
      message: "ping",
    });
  });

  test("leading whitespace before @@ is tolerated", () => {
    expect(parseDispatchDirective("   @@cognee-claude ping")).toEqual({
      target: "cognee-claude",
      message: "ping",
    });
  });

  test("@@target with no message returns empty message", () => {
    expect(parseDispatchDirective("@@cognee-claude")).toEqual({
      target: "cognee-claude",
      message: "",
    });
  });

  test("multi-word message after target preserved verbatim", () => {
    expect(parseDispatchDirective("@@target this is a longer body")).toEqual({
      target: "target",
      message: "this is a longer body",
    });
  });
});

describe("startMatrixBusConsumer", () => {
  test("subscribes to inbound topic and invokes dispatch on matching events", async () => {
    const bus = createGatewayBus();
    let received: DispatchRequest | null = null;
    const handle = startMatrixBusConsumer({
      bus,
      dispatch: async (request) => {
        received = request;
        return { status: "success", body: "ok" };
      },
    });

    bus.publish({
      id: "evt-1",
      type: MATRIX_INBOUND_TOPIC,
      ts: new Date().toISOString(),
      payload: sampleMatrixEvent({ body: "@@cognee-claude ping" }),
    });

    // Dispatch is fire-and-forget — yield to the microtask queue.
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (received === null) throw new Error("dispatch handler not invoked");
    const captured: DispatchRequest = received;
    expect(captured.target).toBe("cognee-claude");
    expect(captured.message).toBe("ping");
    expect(captured.matrixEvent.roomId).toBe("!room:example.org");
    handle.stop();
  });

  test("publishes reply event on dispatch success", async () => {
    const bus = createGatewayBus();
    const replies: GatewayBusEvent<MatrixBusReplyPayload>[] = [];
    bus.subscribe((event) => {
      if (event.type === MATRIX_REPLY_TOPIC) {
        replies.push(event as GatewayBusEvent<MatrixBusReplyPayload>);
      }
    });

    const handle = startMatrixBusConsumer({
      bus,
      dispatch: async () => ({ status: "success", body: "ok-reply" }),
    });

    bus.publish({
      id: "evt-2",
      type: MATRIX_INBOUND_TOPIC,
      ts: new Date().toISOString(),
      payload: sampleMatrixEvent({ body: "@@target hi" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replies.length).toBe(1);
    expect(replies[0]?.type).toBe(MATRIX_REPLY_TOPIC);
    expect(replies[0]?.payload.kind).toBe("success");
    expect(replies[0]?.payload.body).toBe("ok-reply");
    expect(replies[0]?.payload.roomId).toBe("!room:example.org");
    expect(replies[0]?.payload.inReplyToEventId).toBe("$evt1");
    handle.stop();
  });

  test("publishes failure reply event when dispatch handler throws", async () => {
    const bus = createGatewayBus();
    const replies: GatewayBusEvent<MatrixBusReplyPayload>[] = [];
    bus.subscribe((event) => {
      if (event.type === MATRIX_REPLY_TOPIC) {
        replies.push(event as GatewayBusEvent<MatrixBusReplyPayload>);
      }
    });
    let errorCaught: unknown = null;
    const handle = startMatrixBusConsumer({
      bus,
      dispatch: async () => {
        throw new Error("dispatch boom");
      },
      onDispatchError: (error) => {
        errorCaught = error;
      },
    });

    bus.publish({
      id: "evt-3",
      type: MATRIX_INBOUND_TOPIC,
      ts: new Date().toISOString(),
      payload: sampleMatrixEvent({ body: "@@target hi" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replies.length).toBe(1);
    expect(replies[0]?.payload.kind).toBe("failure");
    expect(replies[0]?.payload.body).toContain("dispatch boom");
    // AJS-79 PR3b flip-in-place: failureReason is now a typed
    // DispatchFailureReason object on the same field name. Catch-block
    // emits dispatch_error so bridge can distinguish from
    // consumer_unreachable / dispatch_timeout (which imply retry per
    // DOT-393 Phase B).
    expect(replies[0]?.payload.failureReason).toEqual({
      kind: "dispatch_error",
      message: expect.stringContaining("dispatch boom"),
    });
    expect(errorCaught).toBeInstanceOf(Error);
    handle.stop();
  });

  test("propagates failureReason from DispatchResult to reply payload (consumer_unreachable case)", async () => {
    const bus = createGatewayBus();
    const replies: GatewayBusEvent<MatrixBusReplyPayload>[] = [];
    bus.subscribe((event) => {
      if (event.type === MATRIX_REPLY_TOPIC) {
        replies.push(event as GatewayBusEvent<MatrixBusReplyPayload>);
      }
    });
    const handle = startMatrixBusConsumer({
      bus,
      dispatch: async () => ({
        status: "failure",
        body: "no downstream consumer",
        failureReason: { kind: "consumer_unreachable" },
      }),
    });

    bus.publish({
      id: "evt-unreach",
      type: MATRIX_INBOUND_TOPIC,
      ts: new Date().toISOString(),
      payload: sampleMatrixEvent({ body: "@@target hi" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replies.length).toBe(1);
    expect(replies[0]?.payload.kind).toBe("failure");
    expect(replies[0]?.payload.failureReason).toEqual({ kind: "consumer_unreachable" });
    handle.stop();
  });

  test("ignores events on other topics", async () => {
    const bus = createGatewayBus();
    let invoked = 0;
    const handle = startMatrixBusConsumer({
      bus,
      dispatch: async () => {
        invoked++;
        return { status: "success", body: "" };
      },
    });

    bus.publish({
      id: "evt-other",
      type: "gateway.something.else",
      ts: new Date().toISOString(),
      payload: { unrelated: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoked).toBe(0);
    handle.stop();
  });

  test("malformed payload is skipped, not thrown", async () => {
    const bus = createGatewayBus();
    let invoked = 0;
    let errored: unknown = null;
    const handle = startMatrixBusConsumer({
      bus,
      dispatch: async () => {
        invoked++;
        return { status: "success", body: "" };
      },
      onDispatchError: (e) => {
        errored = e;
      },
    });

    bus.publish({
      id: "evt-bad",
      type: MATRIX_INBOUND_TOPIC,
      ts: new Date().toISOString(),
      payload: { notAMatrixShape: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoked).toBe(0);
    expect(errored).toBeInstanceOf(Error);
    expect(String(errored)).toContain("malformed");
    handle.stop();
  });

  test("threads correlationId through inbound → reply envelope", async () => {
    const bus = createGatewayBus();
    const replies: GatewayBusEvent<MatrixBusReplyPayload>[] = [];
    bus.subscribe((event) => {
      if (event.type === MATRIX_REPLY_TOPIC) {
        replies.push(event as GatewayBusEvent<MatrixBusReplyPayload>);
      }
    });
    const handle = startMatrixBusConsumer({
      bus,
      dispatch: async () => ({ status: "success", body: "ok" }),
    });

    bus.publish({
      id: "evt-corr",
      type: MATRIX_INBOUND_TOPIC,
      ts: new Date().toISOString(),
      correlationId: "trace-abc",
      payload: sampleMatrixEvent({ body: "@@target hi" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replies[0]?.correlationId).toBe("trace-abc");
    handle.stop();
  });

  test("stop() unsubscribes and subsequent events are ignored", async () => {
    const bus = createGatewayBus();
    let invoked = 0;
    const handle = startMatrixBusConsumer({
      bus,
      dispatch: async () => {
        invoked++;
        return { status: "success", body: "" };
      },
    });
    handle.stop();
    expect(handle.active).toBe(false);

    bus.publish({
      id: "evt-after-stop",
      type: MATRIX_INBOUND_TOPIC,
      ts: new Date().toISOString(),
      payload: sampleMatrixEvent({ body: "@@target hi" }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invoked).toBe(0);
  });
});

// Test stubs for follow-up implementation slices (E4.0-b continued):
// these document the contract surface that wiring + bridge swap must
// satisfy, but the implementation of those slices is gated on the
// dispatch handler being wired to HostA2AExecutor's A2A endpoint and
// matrix_nio_bridge.py being swapped to /admin/publish.

describe("E4.0-b follow-up — dispatch wiring (test.todo)", () => {
  // Intent: in `apps/internal-gateway/main.ts`, the wire-up commit
  // constructs a dispatch handler that POSTs to the gateway's own A2A
  // endpoint with the consumer's `request.message` body, threading the
  // `@@target` directive verbatim so HostA2AExecutor sees the same
  // shape as a direct A2A client send. This test asserts the
  // end-to-end round-trip behaves identically to the direct path.
  test.todo("dispatch handler wired to gateway's own A2A endpoint routes @@target correctly", () => {});

  // Intent: cognee-claude's dot-matrix bridge swap (DOT-393 Phase B
  // preservation) — the bridge sees `MatrixBusReplyPayload.failureReason
  // === "consumer-unreachable"` (or "dispatch-timeout") and falls back
  // to direct HTTP A2A POST as before. Asserts the reply discriminator
  // is sufficient for the bridge's retry decision without consulting
  // any internal gateway state.
  test.todo("DOT-393 Phase B fallback preserved: bridge-side fallback on persistent failure", () => {});

  // Intent: the bus-publish path emits structured log lines
  // (`log_struct gateway_delivery_dispatched`) equivalent to the direct
  // HTTP A2A path's logging, so existing observability dashboards
  // continue to work without query rewrites. Asserts the wire-up
  // commit threads correlationId + sourcePrincipal into log entries.
  test.todo("observability surface: log_struct gateway_delivery_dispatched preserved through bus path", () => {});

  // Intent: mcp-bus-bridge (observability consumer) and the matrix
  // replier (which delivers `gateway.matrix.reply-sent` back to the
  // Matrix room) both subscribe to the same bus and both receive each
  // event independently. Asserts no consumer claims exclusive ownership
  // of the reply topic.
  test.todo("multi-consumer fan-out: mcp-bus-bridge and matrix replier both receive reply events", () => {});

  // Intent: live deployment smoke — after dot-proxmox redeploys LXC 189
  // off agents-js HEAD, `curl http://10.0.1.192:9321/events` returns
  // 200 with an active SSE stream (currently 404). Asserts the
  // `/events` route is bound at startup, not just present in source.
  test.todo("LXC 189 deployed revision exposes /events SSE (404 → 200 acceptance gate)", () => {});
});
