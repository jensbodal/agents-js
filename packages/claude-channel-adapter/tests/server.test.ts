/**
 * Unit-level coverage for the {@link createClaudeChannelServer} contract.
 *
 * Live Claude Code harness integration (real `--channels` launch,
 * `notifications/claude/channel` arrival in the running session) is
 * hostname-null-claude-0's DRI lane per ADR-0007 §Revision-2026-05-28 —
 * these tests stay at the in-process contract level (sender-gate
 * composition, sanitizer composition, connect-required guard).
 */

import { describe, expect, test } from "bun:test";
import { createSenderGate } from "../src/sender-gate.ts";
import { createClaudeChannelServer, type GatewayEmit } from "../src/server.ts";

function noopGatewayEmit(): GatewayEmit {
  return {
    reply: async () => ({ ok: true }),
    send: async () => ({ ok: true }),
  };
}

describe("createClaudeChannelServer", () => {
  test("emitChannelMessage requires connect() first", async () => {
    const server = createClaudeChannelServer({
      serverInfo: { name: "test", version: "0.0.0" },
      senderGate: createSenderGate({ allowedSenders: ["sender"] }),
      gatewayEmit: noopGatewayEmit(),
    });
    expect(server.emitChannelMessage({ content: "hi", sender: "sender" })).rejects.toThrow(
      /connect\(\) must be called first/,
    );
  });

  test("close() before connect() is a no-op (doesn't throw)", async () => {
    const server = createClaudeChannelServer({
      serverInfo: { name: "test", version: "0.0.0" },
      senderGate: createSenderGate({ allowedSenders: ["sender"] }),
      gatewayEmit: noopGatewayEmit(),
    });
    await server.close();
  });

  test("emitChannelMessage returns rejected-by-sender-gate when sender is not allowed", async () => {
    const server = createClaudeChannelServer({
      serverInfo: { name: "test", version: "0.0.0" },
      senderGate: createSenderGate({ allowedSenders: ["good"] }),
      gatewayEmit: noopGatewayEmit(),
    });
    // Bypass connect-guard for the gate test: use an in-memory transport.
    const noopTransport = {
      async start() {},
      async send() {},
      async close() {},
      onmessage: undefined,
      onclose: undefined,
      onerror: undefined,
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock transport
    await server.connect(noopTransport as any);
    const result = await server.emitChannelMessage({
      content: "hi",
      sender: "bad",
    });
    expect(result).toEqual({ status: "rejected-by-sender-gate", sender: "bad" });
    await server.close();
  });

  test("emitChannelMessage returns rejected-by-sanitizer on hyphenated meta key", async () => {
    const server = createClaudeChannelServer({
      serverInfo: { name: "test", version: "0.0.0" },
      senderGate: createSenderGate({ allowedSenders: ["good"] }),
      gatewayEmit: noopGatewayEmit(),
    });
    const noopTransport = {
      async start() {},
      async send() {},
      async close() {},
      onmessage: undefined,
      onclose: undefined,
      onerror: undefined,
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock transport
    await server.connect(noopTransport as any);
    const result = await server.emitChannelMessage({
      content: "hi",
      sender: "good",
      meta: { "matrix-origin": "room" },
    });
    expect(result.status).toBe("rejected-by-sanitizer");
    if (result.status === "rejected-by-sanitizer") {
      expect(result.reason).toMatch(/matrix-origin/);
    }
    await server.close();
  });

  test("emitChannelMessage with allowed sender + clean meta succeeds + invokes transport.send", async () => {
    const sent: unknown[] = [];
    const captureTransport = {
      async start() {},
      async send(msg: unknown) {
        sent.push(msg);
      },
      async close() {},
      onmessage: undefined,
      onclose: undefined,
      onerror: undefined,
    };
    const server = createClaudeChannelServer({
      serverInfo: { name: "test", version: "0.0.0" },
      senderGate: createSenderGate({ allowedSenders: ["good"] }),
      gatewayEmit: noopGatewayEmit(),
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock transport
    await server.connect(captureTransport as any);
    const result = await server.emitChannelMessage({
      content: "hello",
      sender: "good",
      meta: { idempotency_key: "k1" },
    });
    expect(result).toEqual({ status: "emitted" });
    expect(sent).toHaveLength(1);
    const frame = sent[0] as {
      method: string;
      params: { content: string; meta: Record<string, unknown> };
    };
    expect(frame.method).toBe("notifications/claude/channel");
    expect(frame.params.content).toBe("hello");
    expect(frame.params.meta.sender).toBe("good");
    expect(frame.params.meta.idempotency_key).toBe("k1");
    await server.close();
  });

  test("sender-spoofing defense: caller-supplied meta.sender CANNOT override gated sender", async () => {
    // Regression for hostname-null-claude-0 live-smoke finding 2026-05-28
    // ($91CJLzvbFuM073MDKi_gpa7hK486hzHZiDRy69Yezao): the spread-order in
    // `emitChannelMessage` used to be `{sender: input.sender, ...input.meta}`,
    // which let a caller's `meta.sender` overwrite the value that just
    // passed the sender-gate. The fix flips to `{...input.meta, sender:
    // input.sender}` so the gated sender wins.
    const sent: unknown[] = [];
    const captureTransport = {
      async start() {},
      async send(msg: unknown) {
        sent.push(msg);
      },
      async close() {},
      onmessage: undefined,
      onclose: undefined,
      onerror: undefined,
    };
    const server = createClaudeChannelServer({
      serverInfo: { name: "test", version: "0.0.0" },
      // Only "trusted-peer" passes the gate; "attacker" must NOT appear in
      // the rendered <channel source=…> tag even though caller-meta tries.
      senderGate: createSenderGate({ allowedSenders: ["trusted-peer"] }),
      gatewayEmit: noopGatewayEmit(),
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal mock transport
    await server.connect(captureTransport as any);
    const result = await server.emitChannelMessage({
      content: "hi",
      sender: "trusted-peer", // gate-passed
      meta: { sender: "attacker", idempotency_key: "k1" }, // spoof attempt
    });
    expect(result).toEqual({ status: "emitted" });
    const frame = sent[0] as {
      params: { meta: Record<string, unknown> };
    };
    // CRITICAL: gated sender wins, caller-supplied spoof is dropped
    expect(frame.params.meta.sender).toBe("trusted-peer");
    expect(frame.params.meta.sender).not.toBe("attacker");
    expect(frame.params.meta.idempotency_key).toBe("k1");
    await server.close();
  });
});
