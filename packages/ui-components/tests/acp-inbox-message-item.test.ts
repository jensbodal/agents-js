import { describe, expect, test } from "bun:test";
import { AcpInboxMessageItem, type InboxMessageLike, registerAllComponents } from "../src/index.ts";

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
});
