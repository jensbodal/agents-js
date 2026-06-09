/**
 * Unit contract for the harness-agnostic inbox sink (`createInboxSink`).
 *
 * The sink spine — author-extract → meta-map → emit → reply-target tracking →
 * rejection-throws-for-retry — used to live inlined in `bin/launcher.ts` (and was
 * duplicated in `launcher-integration.test.ts`). It is harness-agnostic: only the
 * `emit` callback is harness-specific (Claude → `server.emitChannelMessage`, a
 * second harness → its own surface). These tests pin the mapping contract with a
 * fake `emit`, so a second-harness sink can compose it instead of re-implementing
 * the loop. No transport is named here — that boundary stays open per ADR-0008.
 */
import { describe, expect, test } from "bun:test";
import type { InboxMessage } from "../src/gateway-inbox-client.ts";
import { createInboxSink, type InboxSinkEmitResult } from "../src/inbox-sink.ts";

type EmitInput = {
  readonly content: string;
  readonly sender: string;
  readonly meta?: Readonly<Record<string, unknown>>;
};

/** Fake emit recording its inputs and returning a configurable result. */
function recordingEmit(result: InboxSinkEmitResult = { status: "emitted" }) {
  const calls: EmitInput[] = [];
  const emit = async (input: EmitInput): Promise<InboxSinkEmitResult> => {
    calls.push(input);
    return result;
  };
  return { emit, calls };
}

/** Assert exactly one emit happened and return it (narrows past strict index). */
function firstCall(calls: readonly EmitInput[]): EmitInput {
  expect(calls).toHaveLength(1);
  const [first] = calls;
  if (!first) throw new Error("expected exactly one emit");
  return first;
}

const NATIVE_ROW: InboxMessage = {
  message_id: "m-native",
  body: "ping from a peer agent",
  kind: "agents_message",
  idempotency_key: "idem-1",
  sender: "ajs-claude",
};

const MATRIX_ROW: InboxMessage = {
  message_id: "m-matrix",
  body: "hello from the room",
  kind: "matrix_room_mention",
  idempotency_key: "evt1:hostname-null-claude-0",
  matrix_origin: {
    event_id: "$evt1",
    room_id: "!room:server",
    sender: "@ajs-claude:matrix",
  },
};

describe("createInboxSink — harness-agnostic poll→emit spine", () => {
  test("maps a native row to one emit with relay sender layered over author meta", async () => {
    const { emit, calls } = recordingEmit();
    const sink = createInboxSink({ emit });

    await sink(NATIVE_ROW);

    const input = firstCall(calls);
    expect(input.content).toBe("ping from a peer agent");
    // The gate-checked sender is the trusted relay, never row content.
    expect(input.sender).toBe("agents-gateway-inbox");
    expect(input.meta).toMatchObject({
      source: "agents_gateway_inbox",
      sender_identity: "ajs-claude",
      kind: "agents_message",
      message_id: "m-native",
      idempotency_key: "idem-1",
      // A native routable sender is surfaced as a threadable reply target.
      reply_to: "ajs-claude",
    });
  });

  test("extracts author from matrix_origin and maps room/event meta", async () => {
    const { emit, calls } = recordingEmit();
    const sink = createInboxSink({ emit });

    await sink(MATRIX_ROW);

    const input = firstCall(calls);
    expect(input.meta).toMatchObject({
      sender_identity: "@ajs-claude:matrix",
      kind: "matrix_room_mention",
      room_id: "!room:server",
      matrix_event_id: "$evt1",
    });
    // A Matrix mxid origin is NOT a routable directory entity → no reply_to.
    expect(input.meta).not.toHaveProperty("reply_to");
  });

  test("reports the routable reply target via onReplyTarget", async () => {
    const { emit } = recordingEmit();
    const seen: Array<string | undefined> = [];
    const sink = createInboxSink({ emit, onReplyTarget: (t) => seen.push(t) });

    await sink(NATIVE_ROW);
    await sink(MATRIX_ROW);

    // Native sender is routable; matrix mxid origin is not.
    expect(seen).toEqual(["ajs-claude", undefined]);
  });

  test("throws when emit is rejected so the poller retries instead of marking seen", async () => {
    const { emit } = recordingEmit({
      status: "rejected-by-sender-gate",
    });
    const sink = createInboxSink({ emit });

    await expect(sink(NATIVE_ROW)).rejects.toThrow(/rejected/);
  });

  test("honors a custom relay sender", async () => {
    const { emit, calls } = recordingEmit();
    const sink = createInboxSink({ emit, relaySender: "codex-gateway-inbox" });

    await sink(NATIVE_ROW);

    expect(firstCall(calls).sender).toBe("codex-gateway-inbox");
  });

  test("falls back to 'unknown' author and default kind for a bare row", async () => {
    const { emit, calls } = recordingEmit();
    const sink = createInboxSink({ emit });

    await sink({ message_id: "m-bare", body: "no author, no kind" });

    const input = firstCall(calls);
    expect(input.meta).toMatchObject({
      sender_identity: "unknown",
      kind: "agents_message",
      message_id: "m-bare",
    });
    expect(input.meta).not.toHaveProperty("idempotency_key");
  });
});
