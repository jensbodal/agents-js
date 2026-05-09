import { describe, expect, test } from "bun:test";
import { EventSchemas, EventType } from "@ag-ui/core";
import { createAguiEventStream } from "../src/index.ts";

function makeIdFactory(): () => string {
  let n = 0;
  return () => `msg_${++n}`;
}

describe("createAguiEventStream — text lifecycle", () => {
  test("first textChunk emits START + CONTENT and opens a message", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    const events = stream.textChunk({ text: "Hello" });

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(events[1]?.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    for (const event of events) expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("subsequent textChunk emits only CONTENT", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    stream.textChunk({ text: "Hello" });
    const events = stream.textChunk({ text: " world" });

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(() => EventSchemas.parse(events[0])).not.toThrow();
  });

  test("idFactory drives the auto-generated messageId", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    const [start, content] = stream.textChunk({ text: "Hi" });

    expect(start && "messageId" in start ? start.messageId : undefined).toBe("msg_1");
    expect(content && "messageId" in content ? content.messageId : undefined).toBe("msg_1");
  });

  test("a different caller-supplied messageId mid-stream auto-closes the prior message", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    stream.textChunk({ text: "Hello", messageId: "a" });
    const events = stream.textChunk({ text: "Goodbye", messageId: "b" });

    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe(EventType.TEXT_MESSAGE_END);
    expect(events[1]?.type).toBe(EventType.TEXT_MESSAGE_START);
    expect(events[2]?.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(events[0] && "messageId" in events[0] ? events[0].messageId : undefined).toBe("a");
    expect(events[1] && "messageId" in events[1] ? events[1].messageId : undefined).toBe("b");
    for (const event of events) expect(() => EventSchemas.parse(event)).not.toThrow();
  });

  test("textEnd emits END and clears the open message", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    stream.textChunk({ text: "Hi" });
    const ended = stream.textEnd();

    expect(ended).toHaveLength(1);
    expect(ended[0]?.type).toBe(EventType.TEXT_MESSAGE_END);
    expect(() => EventSchemas.parse(ended[0])).not.toThrow();

    // Subsequent chunk opens a fresh message.
    const next = stream.textChunk({ text: "again" });
    expect(next[0]?.type).toBe(EventType.TEXT_MESSAGE_START);
  });

  test("textEnd is idempotent when no message is open", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    expect(stream.textEnd()).toEqual([]);
    expect(stream.textEnd()).toEqual([]);
  });
});

describe("createAguiEventStream — tool-call dedup", () => {
  test("toolCallStart dedups by toolCallId", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    const first = stream.toolCallStart({ toolName: "fs.read", toolCallId: "t1" });
    const second = stream.toolCallStart({ toolName: "fs.read", toolCallId: "t1" });

    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe(EventType.TOOL_CALL_START);
    expect(second).toEqual([]);
    expect(() => EventSchemas.parse(first[0])).not.toThrow();
  });

  test("toolCallEnd dedups by toolCallId", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    stream.toolCallStart({ toolName: "fs.read", toolCallId: "t1" });
    const first = stream.toolCallEnd({ toolCallId: "t1" });
    const second = stream.toolCallEnd({ toolCallId: "t1" });

    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe(EventType.TOOL_CALL_END);
    expect(second).toEqual([]);
    expect(() => EventSchemas.parse(first[0])).not.toThrow();
  });

  test("toolCallArgs has no dedup and round-trips", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    const a = stream.toolCallArgs({ toolCallId: "t1", argsChunk: "{" });
    const b = stream.toolCallArgs({ toolCallId: "t1", argsChunk: "}" });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.type).toBe(EventType.TOOL_CALL_ARGS);
    expect(() => EventSchemas.parse(a[0])).not.toThrow();
    expect(() => EventSchemas.parse(b[0])).not.toThrow();
  });
});

describe("createAguiEventStream — pass-through helpers", () => {
  test("custom, runFinished, runError each emit a single valid event", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    const custom = stream.custom({ name: "ping", value: { n: 1 } });
    const finished = stream.runFinished({ threadId: "thr", runId: "run" });
    const errored = stream.runError({ message: "boom", code: "E_BOOM" });

    expect(custom[0]?.type).toBe(EventType.CUSTOM);
    expect(finished[0]?.type).toBe(EventType.RUN_FINISHED);
    expect(errored[0]?.type).toBe(EventType.RUN_ERROR);
    for (const event of [custom[0], finished[0], errored[0]]) {
      expect(() => EventSchemas.parse(event)).not.toThrow();
    }
  });
});

describe("createAguiEventStream — run completion resets state", () => {
  test("runFinished closes any open text message before emitting RUN_FINISHED", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    stream.textChunk({ text: "hi" });

    const events = stream.runFinished({ threadId: "thr", runId: "run" });

    expect(events.map((e) => e.type)).toEqual([EventType.TEXT_MESSAGE_END, EventType.RUN_FINISHED]);
  });

  test("runError closes any open text message before emitting RUN_ERROR", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    stream.textChunk({ text: "hi" });

    const events = stream.runError({ message: "boom" });

    expect(events.map((e) => e.type)).toEqual([EventType.TEXT_MESSAGE_END, EventType.RUN_ERROR]);
  });

  test("runFinished clears tool-call dedup so a reused id emits in the next run", () => {
    const stream = createAguiEventStream({ idFactory: makeIdFactory() });
    stream.toolCallStart({ toolName: "t", toolCallId: "tc-1" });
    stream.runFinished({ threadId: "thr", runId: "run-1" });

    const reuseStart = stream.toolCallStart({ toolName: "t", toolCallId: "tc-1" });
    const reuseEnd = stream.toolCallEnd({ toolCallId: "tc-1" });

    expect(reuseStart).toHaveLength(1);
    expect(reuseEnd).toHaveLength(1);
  });
});

describe("createAguiEventStream — defaults", () => {
  test("falls back to crypto.randomUUID when no idFactory is provided", () => {
    const stream = createAguiEventStream();
    const [start] = stream.textChunk({ text: "hi" });

    const id = start && "messageId" in start ? String(start.messageId) : "";
    // crypto.randomUUID returns a 36-char canonical UUID; assert it's a non-trivial string.
    expect(id.length).toBeGreaterThan(8);
  });
});
