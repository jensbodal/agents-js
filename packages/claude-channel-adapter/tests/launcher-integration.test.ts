/**
 * Integration coverage for the durable channel launcher's poll -> emit seam.
 *
 * Proves the full inbound path end to end at the in-process contract level:
 * a real {@link createClaudeChannelServer} (with the launcher's exact
 * sender-gate allowlist) connected to a capturing Transport, fed by
 * {@link runInboxPoller} reading a FakeGatewayInboxClient, with an onMessage
 * sink that REPLICATES channel-launcher.ts. One poll is driven (the sleepImpl
 * aborts on first call), and the dispatched `notifications/claude/channel`
 * frame is asserted: content/meta mapping plus the sender-spoofing defense
 * (the gated sender is layered OVER caller-supplied meta).
 */

import { describe, expect, test } from "bun:test";
import { MemoryCursorStore } from "../src/cursor-store.ts";
import type {
  GatewayInboxClient,
  GetMessagesResult,
  InboxMessage,
  SendMessageResult,
} from "../src/gateway-inbox-client.ts";
import { runInboxPoller } from "../src/inbox-poller.ts";
import { createSenderGate } from "../src/sender-gate.ts";
import { createClaudeChannelServer, type GatewayEmit } from "../src/server.ts";

const IDENTITY = "hostname-null-claude-0";

/** Capturing Transport: records every dispatched frame. Mirrors server.test.ts. */
function createCaptureTransport(sent: unknown[]) {
  return {
    async start() {},
    async send(msg: unknown) {
      sent.push(msg);
    },
    async close() {},
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
  };
}

/** GatewayEmit double whose reply/send only record calls. */
function recordingGatewayEmit(
  calls: Array<{ kind: string; target: string; content: string }>,
): GatewayEmit {
  return {
    reply: async (target: string, content: string) => {
      calls.push({ kind: "reply", target, content });
      return { ok: true };
    },
    send: async (target: string, content: string) => {
      calls.push({ kind: "send", target, content });
      return { ok: true };
    },
  };
}

/** Fake durable-inbox client returning ONE bridge-fanout row. */
class FakeGatewayInboxClient implements GatewayInboxClient {
  constructor(private readonly rows: InboxMessage[]) {}
  async getMessages(args: { identity: string; limit?: number }): Promise<GetMessagesResult> {
    return { ok: true, identity: args.identity, messages: this.rows };
  }
  async sendMessage(): Promise<SendMessageResult> {
    return { ok: true };
  }
  async close(): Promise<void> {}
}

describe("durable channel launcher poll -> emit seam", () => {
  test("one inbox row drives exactly one notifications/claude/channel frame with mapped meta", async () => {
    const sent: unknown[] = [];
    const gatewayCalls: Array<{ kind: string; target: string; content: string }> = [];

    const server = createClaudeChannelServer({
      serverInfo: { name: "agentsjs-channel-hostname-null", version: "0.1.0" },
      senderGate: createSenderGate({ allowedSenders: ["agents-gateway-inbox", "test-harness"] }),
      gatewayEmit: recordingGatewayEmit(gatewayCalls),
    });
    await server.connect(createCaptureTransport(sent) as never);

    const client = new FakeGatewayInboxClient([
      {
        message_id: "m1",
        kind: "matrix_room_mention",
        idempotency_key: "evt1:hostname-null-claude-0",
        matrix_origin: {
          event_id: "$evt1",
          room_id: "!room:server",
          sender: "@ajs-claude:matrix",
        },
        body: "hello from the mesh",
      },
    ]);

    // Drive exactly ONE poll: the sleepImpl aborts on its first call.
    const controller = new AbortController();
    await runInboxPoller({
      client,
      identity: IDENTITY,
      cursorStore: new MemoryCursorStore(),
      signal: controller.signal,
      logger: { log() {}, warn() {}, error() {} },
      sleepImpl: async () => {
        controller.abort();
      },
      // REPLICATES channel-launcher.ts onMessage (the real launcher sink).
      onMessage: async (row) => {
        const author = row.matrix_origin?.sender ?? row.sender ?? "unknown";
        const res = await server.emitChannelMessage({
          content: row.body,
          sender: "agents-gateway-inbox",
          meta: {
            source: "agents_gateway_inbox",
            sender_identity: author,
            kind: row.kind ?? "agents_message",
            message_id: row.message_id,
            ...(row.idempotency_key ? { idempotency_key: row.idempotency_key } : {}),
            ...(row.matrix_origin?.room_id ? { room_id: row.matrix_origin.room_id } : {}),
            ...(row.matrix_origin?.event_id ? { matrix_event_id: row.matrix_origin.event_id } : {}),
          },
        });
        if (res.status !== "emitted") {
          throw new Error(`emit rejected: ${res.status}`);
        }
      },
    });

    // Exactly one frame dispatched, with the channel method.
    expect(sent).toHaveLength(1);
    const frame = sent[0] as {
      method: string;
      params: { content: string; meta: Record<string, unknown> };
    };
    expect(frame.method).toBe("notifications/claude/channel");

    // Content + meta mapping.
    expect(frame.params.content).toBe("hello from the mesh");
    expect(frame.params.meta.message_id).toBe("m1");
    expect(frame.params.meta.kind).toBe("matrix_room_mention");
    expect(frame.params.meta.sender_identity).toBe("@ajs-claude:matrix");

    // Sender-spoofing defense: the gated relay sender is layered over meta.
    expect(frame.params.meta.sender).toBe("agents-gateway-inbox");

    // Required keys present.
    expect(frame.params.meta).toHaveProperty("message_id");
    expect(frame.params.meta).toHaveProperty("kind");

    // Outbound tools were not exercised by the inbound path.
    expect(gatewayCalls).toHaveLength(0);

    await server.close();
  });
});
