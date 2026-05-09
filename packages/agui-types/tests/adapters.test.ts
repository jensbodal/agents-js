import { describe, expect, test } from "bun:test";
import { EventSchemas, EventType } from "@ag-ui/core";
import {
  toAguiCustom,
  toAguiReasoningEnd,
  toAguiReasoningStart,
  toAguiRunError,
  toAguiRunFinished,
  toAguiTextMessageContent,
  toAguiTextMessageEnd,
  toAguiTextMessageStart,
  toAguiToolCallArgs,
  toAguiToolCallEnd,
  toAguiToolCallStart,
} from "../src/index.ts";

describe("toAguiToolCallArgs", () => {
  test("renames argsChunk to delta", () => {
    const event = toAguiToolCallArgs({
      toolCallId: "call_123",
      argsChunk: '{"path":"/foo"}',
    });

    expect(event.type).toBe(EventType.TOOL_CALL_ARGS);
    expect(event.toolCallId).toBe("call_123");
    expect(event.delta).toBe('{"path":"/foo"}');
  });

  test("output validates against EventSchemas", () => {
    const event = toAguiToolCallArgs({
      toolCallId: "call_123",
      argsChunk: "partial",
    });

    // EventSchemas.parse() is the canonical AG-UI runtime validator. If the
    // adapter is non-compliant this call throws.
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("preserves optional timestamp and rawEvent", () => {
    const event = toAguiToolCallArgs({
      toolCallId: "call_123",
      argsChunk: "x",
      timestamp: 1_700_000_000,
      rawEvent: { provider: "anthropic" },
    });

    expect(event.timestamp).toBe(1_700_000_000);
    expect(event.rawEvent).toEqual({ provider: "anthropic" });
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("accepts empty delta (pre-tool open signal)", () => {
    const event = toAguiToolCallArgs({
      toolCallId: "call_123",
      argsChunk: "",
    });

    expect(event.delta).toBe("");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });
});

describe("toAguiReasoningStart", () => {
  test("uses provided messageId", () => {
    const event = toAguiReasoningStart({ messageId: "reasoning_abc" });

    expect(event.type).toBe(EventType.REASONING_START);
    expect(event.messageId).toBe("reasoning_abc");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("generates messageId when missing", () => {
    const event = toAguiReasoningStart();

    expect(event.type).toBe(EventType.REASONING_START);
    expect(typeof event.messageId).toBe("string");
    expect(event.messageId.length).toBeGreaterThan(0);
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("generated ids are unique per call", () => {
    const a = toAguiReasoningStart();
    const b = toAguiReasoningStart();
    expect(a.messageId).not.toBe(b.messageId);
  });
});

describe("toAguiReasoningEnd", () => {
  test("passes messageId through", () => {
    const event = toAguiReasoningEnd({ messageId: "reasoning_abc" });

    expect(event.type).toBe(EventType.REASONING_END);
    expect(event.messageId).toBe("reasoning_abc");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("start/end ids compose round-trip", () => {
    const start = toAguiReasoningStart();
    const end = toAguiReasoningEnd({ messageId: start.messageId });

    expect(end.messageId).toBe(start.messageId);
    expect(() => EventSchemas.parse(start)).not.toThrow();
    expect(() => EventSchemas.parse(end)).not.toThrow();
  });
});

describe("toAguiTextMessageContent", () => {
  test("first delta (no previous text) emits full text", () => {
    const event = toAguiTextMessageContent({ messageId: "msg_1", text: "Hello" }, "");

    expect(event.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(event.messageId).toBe("msg_1");
    expect(event.delta).toBe("Hello");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("subsequent delta is the suffix after previousText", () => {
    const event = toAguiTextMessageContent({ messageId: "msg_1", text: "Hello world" }, "Hello");

    expect(event.delta).toBe(" world");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("identical accumulated text yields empty delta (valid)", () => {
    const event = toAguiTextMessageContent({ messageId: "msg_1", text: "Hello" }, "Hello");

    expect(event.delta).toBe("");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("non-prefix previous text falls back to full text (replace semantics)", () => {
    // Upstream retransmit / replaced content: previousText is NOT a prefix.
    const event = toAguiTextMessageContent(
      { messageId: "msg_1", text: "new content" },
      "something unrelated",
    );

    expect(event.delta).toBe("new content");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("preserves optional timestamp and rawEvent", () => {
    const event = toAguiTextMessageContent(
      {
        messageId: "msg_1",
        text: "hi",
        timestamp: 42,
        rawEvent: { source: "test" },
      },
      "",
    );

    expect(event.timestamp).toBe(42);
    expect(event.rawEvent).toEqual({ source: "test" });
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });
});

describe("toAguiTextMessageStart", () => {
  test("emits the canonical START event with default role", () => {
    const event = toAguiTextMessageStart({ messageId: "msg_1" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(event.messageId).toBe("msg_1");
    expect(event.role).toBe("assistant");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("honors caller-supplied role and name", () => {
    const event = toAguiTextMessageStart({
      messageId: "msg_2",
      role: "user",
      name: "ada",
    });

    expect(event.role).toBe("user");
    expect(event.name).toBe("ada");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("preserves optional timestamp and rawEvent", () => {
    const event = toAguiTextMessageStart({
      messageId: "msg_3",
      timestamp: 99,
      rawEvent: { ok: true },
    });

    expect(event.timestamp).toBe(99);
    expect(event.rawEvent).toEqual({ ok: true });
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });
});

describe("toAguiTextMessageEnd", () => {
  test("emits the canonical END event", () => {
    const event = toAguiTextMessageEnd({ messageId: "msg_1" });

    expect(event.type).toBe(EventType.TEXT_MESSAGE_END);
    expect(event.messageId).toBe("msg_1");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("preserves optional timestamp", () => {
    const event = toAguiTextMessageEnd({ messageId: "msg_1", timestamp: 7 });
    expect(event.timestamp).toBe(7);
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });
});

describe("toAguiToolCallStart", () => {
  test("forwards toolCallId and toolCallName", () => {
    const event = toAguiToolCallStart({
      toolCallId: "call_1",
      toolCallName: "fs.read",
    });

    expect(event.type).toBe(EventType.TOOL_CALL_START);
    expect(event.toolCallId).toBe("call_1");
    expect(event.toolCallName).toBe("fs.read");
    expect(event.parentMessageId).toBeUndefined();
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("includes parentMessageId when supplied", () => {
    const event = toAguiToolCallStart({
      toolCallId: "call_1",
      toolCallName: "fs.read",
      parentMessageId: "msg_42",
    });

    expect(event.parentMessageId).toBe("msg_42");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });
});

describe("toAguiToolCallEnd", () => {
  test("emits the canonical END event", () => {
    const event = toAguiToolCallEnd({ toolCallId: "call_1" });

    expect(event.type).toBe(EventType.TOOL_CALL_END);
    expect(event.toolCallId).toBe("call_1");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });
});

describe("toAguiRunFinished", () => {
  test("emits a RUN_FINISHED event with thread + run ids", () => {
    const event = toAguiRunFinished({ threadId: "thr_1", runId: "run_1" });

    expect(event.type).toBe(EventType.RUN_FINISHED);
    expect(event.threadId).toBe("thr_1");
    expect(event.runId).toBe("run_1");
    expect(event.result).toBeUndefined();
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("forwards optional result payload", () => {
    const event = toAguiRunFinished({
      threadId: "thr_1",
      runId: "run_1",
      result: { ok: true },
    });

    expect(event.result).toEqual({ ok: true });
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });
});

describe("toAguiRunError", () => {
  test("emits a RUN_ERROR with a message", () => {
    const event = toAguiRunError({ message: "boom" });

    expect(event.type).toBe(EventType.RUN_ERROR);
    expect(event.message).toBe("boom");
    expect(event.code).toBeUndefined();
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("forwards optional code", () => {
    const event = toAguiRunError({ message: "boom", code: "E_FOO" });

    expect(event.code).toBe("E_FOO");
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });
});

describe("toAguiCustom", () => {
  test("emits a CUSTOM event with name and value", () => {
    const event = toAguiCustom({ name: "ping", value: { n: 1 } });

    expect(event.type).toBe(EventType.CUSTOM);
    expect(event.name).toBe("ping");
    expect(event.value).toEqual({ n: 1 });
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("accepts arbitrary value shapes", () => {
    const event = toAguiCustom({ name: "tick", value: 0 });
    expect(event.value).toBe(0);
    expect(() => EventSchemas.parse(event)).not.toThrow();
  });
});

describe("EventSchemas round-trip", () => {
  test("parses then re-validates every adapter output", () => {
    const events = [
      toAguiToolCallArgs({ toolCallId: "t1", argsChunk: "args" }),
      toAguiReasoningStart({ messageId: "r1" }),
      toAguiReasoningEnd({ messageId: "r1" }),
      toAguiTextMessageContent({ messageId: "m1", text: "hello" }, ""),
      toAguiTextMessageStart({ messageId: "m1" }),
      toAguiTextMessageEnd({ messageId: "m1" }),
      toAguiToolCallStart({ toolCallId: "t1", toolCallName: "fs.read" }),
      toAguiToolCallEnd({ toolCallId: "t1" }),
      toAguiRunFinished({ threadId: "thr", runId: "run" }),
      toAguiRunError({ message: "boom" }),
      toAguiCustom({ name: "ping", value: 1 }),
    ];

    for (const event of events) {
      const parsed = EventSchemas.parse(event);
      // Discriminator survives parse -> re-parse.
      expect(() => EventSchemas.parse(parsed)).not.toThrow();
    }
  });
});
