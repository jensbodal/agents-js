import { describe, expect, test } from "bun:test";
import {
  AcpInboxMessageItem,
  type InboxKindLike,
  type InboxMessageLike,
  KNOWN_INBOX_KINDS_LIKE,
  type MatrixOriginEnvelopeLike,
  normalizeInboxKindLike,
  registerAllComponents,
} from "../src/index.ts";

describe("AcpInboxMessageItem", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpInboxMessageItem).toBe("function");
  });

  test("has static styles (theme + component)", () => {
    expect(AcpInboxMessageItem.styles).toBeDefined();
    expect(Array.isArray(AcpInboxMessageItem.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("exposes reactive `message` property", () => {
    const props = AcpInboxMessageItem.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("message")).toBeDefined();
  });

  test("`message` property is non-attribute (object payload, not string)", () => {
    const messageProp = AcpInboxMessageItem.elementProperties.get("message");
    expect(messageProp?.attribute).toBe(false);
  });

  test("InboxMessageLike type accepts a minimal valid message", () => {
    // Type-level smoke: if this compiles, the public surface accepts the
    // shape we promise. No runtime assertions beyond construction.
    const minimal: InboxMessageLike = {
      message_id: "msg-1",
      from_session: "alice",
      to_session: "bob",
      created_at: "2026-05-26T00:00:00.000Z",
      body: "hello",
    };
    expect(minimal.message_id).toBe("msg-1");
  });

  test("InboxMessageLike accepts optional priority", () => {
    const withPriority: InboxMessageLike = {
      message_id: "msg-2",
      from_session: "alice",
      to_session: "bob",
      created_at: "2026-05-26T00:00:00.000Z",
      body: "urgent",
      priority: "high",
    };
    expect(withPriority.priority).toBe("high");
  });

  // ============================================================
  // AJS-88 / DOT-502 v0.2 — kind + matrix_origin widening
  // ============================================================

  test("InboxMessageLike accepts kind + matrix_origin (AJS-88 widening)", () => {
    // Type-level smoke: the widened surface accepts the bridge-fanout
    // shape end-to-end. Compilation alone is the assertion; the runtime
    // check is incidental.
    const fanoutRow: InboxMessageLike = {
      message_id: "msg-fanout-1",
      from_session: "@user:matrix.example",
      to_session: "ajs-claude",
      created_at: "2026-05-26T00:00:00.000Z",
      body: "@ajs-claude please ack",
      kind: "matrix_room_mention",
      matrix_origin: {
        event_id: "$evt-1:matrix.example",
        room_id: "!room:matrix.example",
        sender: "@user:matrix.example",
        origin_server_ts: 1748263200000,
        reply_to_event_id: "$prev:matrix.example",
      },
    };
    expect(fanoutRow.kind).toBe("matrix_room_mention");
    expect(fanoutRow.matrix_origin?.event_id).toBe("$evt-1:matrix.example");
  });

  test("MatrixOriginEnvelopeLike accepts both threaded + non-threaded shapes", () => {
    const nonThreaded: MatrixOriginEnvelopeLike = {
      event_id: "$x",
      room_id: "!r",
      sender: "@u",
      origin_server_ts: 1748263200000,
    };
    const threaded: MatrixOriginEnvelopeLike = {
      ...nonThreaded,
      reply_to_event_id: "$prev",
    };
    expect(nonThreaded.reply_to_event_id).toBeUndefined();
    expect(threaded.reply_to_event_id).toBe("$prev");
  });

  /**
   * WHAT: `normalizeInboxKindLike` collapses absent / unknown to
   *       `"agents_message"` and passes through the two known kinds.
   * WHY:  Spec §7 open-extension: a future bridge that emits
   *       `"sms_inbound"` must NOT crash this consumer; it must
   *       degrade to the legacy semantic. Inlining equality chains
   *       across consumers would silently rot when the union widens
   *       — the predicate-on-Set pattern is the typed enforcement.
   */
  test("normalizeInboxKindLike: known kinds pass through; absent / unknown → 'agents_message'", () => {
    expect(normalizeInboxKindLike("matrix_room_mention")).toBe("matrix_room_mention");
    expect(normalizeInboxKindLike("agents_message")).toBe("agents_message");
    expect(normalizeInboxKindLike(undefined)).toBe("agents_message");
    expect(normalizeInboxKindLike(null)).toBe("agents_message");
    expect(normalizeInboxKindLike("")).toBe("agents_message");
    // Forward-compat: future unknown variant from a newer bridge.
    expect(normalizeInboxKindLike("sms_inbound")).toBe("agents_message");
    expect(normalizeInboxKindLike(42)).toBe("agents_message");
    expect(normalizeInboxKindLike({})).toBe("agents_message");
  });

  test("KNOWN_INBOX_KINDS_LIKE Set covers exactly the two declared kinds", () => {
    // Pins the Set against the union so widening one without the other
    // (the boundary-narrowing drift pattern this guard exists to
    // prevent) trips this assertion.
    expect(KNOWN_INBOX_KINDS_LIKE.size).toBe(2);
    expect(KNOWN_INBOX_KINDS_LIKE.has("matrix_room_mention")).toBe(true);
    expect(KNOWN_INBOX_KINDS_LIKE.has("agents_message")).toBe(true);
    // Type-level smoke: ensure InboxKindLike is exported and assignable
    // from a known-kind literal.
    const k: InboxKindLike = "matrix_room_mention";
    expect(KNOWN_INBOX_KINDS_LIKE.has(k)).toBe(true);
  });
});
