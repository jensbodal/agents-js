import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@agents-js/agui-types";
import { EventType } from "@agents-js/agui-types";
import { AGUIStreamError } from "../src/transports/agui-errors.ts";
import { parseAguiSseStream } from "../src/transports/agui-sse-parser.ts";

function chunksOf(strs: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      const next = strs[i];
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next));
      i += 1;
    },
  });
}

async function collect(gen: AsyncGenerator<BaseEvent>): Promise<BaseEvent[]> {
  const out: BaseEvent[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}

describe("parseAguiSseStream", () => {
  test("parses a single RUN_STARTED frame", async () => {
    const body = chunksOf([
      `data: ${JSON.stringify({
        type: EventType.RUN_STARTED,
        threadId: "t1",
        runId: "r1",
      })}\n\n`,
    ]);
    const events = await collect(parseAguiSseStream(body));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
  });

  test("reassembles a frame split across multiple chunks", async () => {
    const payload = JSON.stringify({
      type: EventType.TEXT_MESSAGE_CHUNK,
      messageId: "m1",
      delta: "hello",
    });
    const middle = Math.floor(payload.length / 2);
    const body = chunksOf([`data: ${payload.slice(0, middle)}`, `${payload.slice(middle)}\n\n`]);
    const events = await collect(parseAguiSseStream(body));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.TEXT_MESSAGE_CHUNK);
  });

  test("concatenates multi-line data fields with newlines", async () => {
    const body = chunksOf([
      `data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"m1",\ndata: "delta":"hi"}\n\n`,
    ]);
    const events = await collect(parseAguiSseStream(body));
    expect(events).toHaveLength(1);
    expect((events[0] as { delta?: string }).delta).toBe("hi");
  });

  test("skips SSE comment lines", async () => {
    const body = chunksOf([
      `: this is a keepalive comment\n`,
      `data: ${JSON.stringify({
        type: EventType.RUN_FINISHED,
        threadId: "t1",
        runId: "r1",
      })}\n\n`,
    ]);
    const events = await collect(parseAguiSseStream(body));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.RUN_FINISHED);
  });

  test("strips a single leading space after data:", async () => {
    const body = chunksOf([
      `data:${JSON.stringify({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" })}\n\n`,
    ]);
    const events = await collect(parseAguiSseStream(body));
    expect(events).toHaveLength(1);
  });

  test("handles CRLF line endings", async () => {
    const body = chunksOf([
      `data: ${JSON.stringify({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" })}\r\n\r\n`,
    ]);
    const events = await collect(parseAguiSseStream(body));
    expect(events).toHaveLength(1);
  });

  test("flushes trailing frame without final blank line", async () => {
    // No trailing \n\n — parser should still emit on stream close.
    const body = chunksOf([
      `data: ${JSON.stringify({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" })}\n`,
    ]);
    const events = await collect(parseAguiSseStream(body));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.RUN_FINISHED);
  });

  test("throws AGUIStreamError on malformed JSON", async () => {
    const body = chunksOf([`data: {not json}\n\n`]);
    let err: unknown;
    try {
      await collect(parseAguiSseStream(body));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AGUIStreamError);
  });

  test("throws AGUIStreamError on invalid AG-UI event shape", async () => {
    // Missing required `runId`/`threadId` on RUN_STARTED.
    const body = chunksOf([`data: ${JSON.stringify({ type: EventType.RUN_STARTED })}\n\n`]);
    let err: unknown;
    try {
      await collect(parseAguiSseStream(body));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AGUIStreamError);
  });

  test("ignores non-data SSE fields", async () => {
    const body = chunksOf([
      `event: message\n`,
      `id: 42\n`,
      `retry: 5000\n`,
      `data: ${JSON.stringify({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" })}\n\n`,
    ]);
    const events = await collect(parseAguiSseStream(body));
    expect(events).toHaveLength(1);
  });

  test("parses multiple frames from a single chunk", async () => {
    const body = chunksOf([
      `data: ${JSON.stringify({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" })}\n\n` +
        `data: ${JSON.stringify({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" })}\n\n`,
    ]);
    const events = await collect(parseAguiSseStream(body));
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events[1]?.type).toBe(EventType.RUN_FINISHED);
  });

  test("aborts mid-stream when signal fires", async () => {
    const ac = new AbortController();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: EventType.RUN_STARTED,
                threadId: "t1",
                runId: "r1",
              })}\n\n`,
            ),
          );
        }
        // Never closes on its own — we rely on abort.
      },
    });
    const gen = parseAguiSseStream(body, ac.signal);
    const first = await gen.next();
    expect(first.done).toBe(false);
    ac.abort();
    const second = await gen.next();
    expect(second.done).toBe(true);
  });
});
