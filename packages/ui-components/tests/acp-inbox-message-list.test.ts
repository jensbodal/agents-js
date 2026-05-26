import { describe, expect, test } from "bun:test";
import {
  AcpInboxMessageList,
  filterMessages,
  type InboxMessageLike,
  registerAllComponents,
} from "../src/index.ts";

const SAMPLE_MESSAGES: InboxMessageLike[] = [
  {
    message_id: "msg-1",
    from_session: "alice",
    to_session: "ajs-claude",
    created_at: "2026-05-26T10:00:00.000Z",
    body: "hello from alice",
  },
  {
    message_id: "msg-2",
    from_session: "bob",
    to_session: "ajs-claude",
    created_at: "2026-05-26T10:05:00.000Z",
    body: "bob says hi",
    priority: "high",
  },
  {
    message_id: "msg-3",
    from_session: "Alice",
    to_session: "ajs-claude",
    created_at: "2026-05-26T10:10:00.000Z",
    body: "alice's second message (case-different)",
  },
];

describe("AcpInboxMessageList", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpInboxMessageList).toBe("function");
  });

  test("has static styles", () => {
    expect(AcpInboxMessageList.styles).toBeDefined();
    expect(Array.isArray(AcpInboxMessageList.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("exposes expected reactive properties", () => {
    const props = AcpInboxMessageList.elementProperties;
    expect(props.get("messages")).toBeDefined();
    expect(props.get("heading")).toBeDefined();
    expect(props.get("subtitle")).toBeDefined();
    expect(props.get("loading")).toBeDefined();
    expect(props.get("errorMessage")).toBeDefined();
  });

  test("`messages` property is non-attribute (array payload)", () => {
    const messagesProp = AcpInboxMessageList.elementProperties.get("messages");
    expect(messagesProp?.attribute).toBe(false);
  });

  test("`heading` property is String-typed (attribute)", () => {
    const headingProp = AcpInboxMessageList.elementProperties.get("heading");
    expect(headingProp?.type).toBe(String);
  });

  test("`loading` property is Boolean-typed (attribute)", () => {
    const loadingProp = AcpInboxMessageList.elementProperties.get("loading");
    expect(loadingProp?.type).toBe(Boolean);
  });
});

describe("filterMessages", () => {
  test("returns a fresh array when filter is empty", () => {
    const result = filterMessages(SAMPLE_MESSAGES, "");
    expect(result).toHaveLength(3);
    expect(result).not.toBe(SAMPLE_MESSAGES);
  });

  test("returns a fresh array when filter is whitespace-only", () => {
    const result = filterMessages(SAMPLE_MESSAGES, "   ");
    expect(result).toHaveLength(3);
  });

  test("filters to messages where from_session contains needle (case-insensitive)", () => {
    const result = filterMessages(SAMPLE_MESSAGES, "alice");
    // Both "alice" and "Alice" match the case-insensitive substring.
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.message_id)).toEqual(["msg-1", "msg-3"]);
  });

  test("matches by substring not full equality", () => {
    const result = filterMessages(SAMPLE_MESSAGES, "ali");
    expect(result).toHaveLength(2);
  });

  test("returns empty array when nothing matches", () => {
    const result = filterMessages(SAMPLE_MESSAGES, "carol");
    expect(result).toHaveLength(0);
  });

  test("filter only inspects from_session, not body", () => {
    // body of msg-1 contains "alice" but we explicitly filter on from_session.
    // bob's message body says "hi" but from_session is "bob".
    const result = filterMessages(SAMPLE_MESSAGES, "bob");
    expect(result).toHaveLength(1);
    expect(result[0]?.message_id).toBe("msg-2");
  });

  test("does not mutate input", () => {
    const before = SAMPLE_MESSAGES.length;
    filterMessages(SAMPLE_MESSAGES, "alice");
    expect(SAMPLE_MESSAGES).toHaveLength(before);
  });
});
