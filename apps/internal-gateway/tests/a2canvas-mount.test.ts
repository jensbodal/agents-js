import { expect, test } from "bun:test";
import { type A2CanvasAgentUpdate, createA2CanvasBoardHost } from "@agents-js/a2canvas";
import { createA2CanvasEventsHandler } from "../a2canvas-mount.ts";

function readerOf(response: Response | null | undefined) {
  if (!response?.body) throw new Error("expected response with a body stream");
  return response.body.getReader();
}

const DECODER = new TextDecoder();

/** Read one SSE `data:` frame's JSON payload from the stream. */
async function readView(reader: ReturnType<typeof readerOf>): Promise<unknown> {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended before a data frame arrived");
    const text = DECODER.decode(value);
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    if (line) return JSON.parse(line.slice("data: ".length));
  }
}

const up = (id: string, ts: number): A2CanvasAgentUpdate => ({
  kind: "agent.update",
  principal: { id, signed: true },
  host: "malar",
  task: { label: "build" },
  authority: { scopes: [], assertedVia: "jwt" },
  change: { kind: "progress", summary: "working" },
  ts,
});

test("returns null for non-matching path (caller falls through)", async () => {
  const handler = createA2CanvasEventsHandler(createA2CanvasBoardHost(), { heartbeatMs: 0 });
  const res = await handler(new Request("http://localhost/other"));
  expect(res).toBeNull();
});

test("405 for non-GET on the events path", async () => {
  const handler = createA2CanvasEventsHandler(createA2CanvasBoardHost(), { heartbeatMs: 0 });
  const res = await handler(new Request("http://localhost/a2canvas/events", { method: "POST" }));
  expect(res?.status).toBe(405);
});

test("GET opens an event-stream and emits the current view immediately", async () => {
  const host = createA2CanvasBoardHost();
  host.ingest(up("agent:ajs", 1));
  const handler = createA2CanvasEventsHandler(host, { heartbeatMs: 0 });
  const res = await handler(new Request("http://localhost/a2canvas/events"));
  expect(res?.status).toBe(200);
  expect(res?.headers.get("Content-Type")).toBe("text/event-stream");
  const reader = readerOf(res);
  const view = (await readView(reader)) as { lanes: { lane: string }[] };
  expect(view.lanes.map((l) => l.lane)).toEqual(["agent:ajs"]);
  await reader.cancel();
});

test("pushes a new frame when the board changes after subscribe", async () => {
  const host = createA2CanvasBoardHost();
  const handler = createA2CanvasEventsHandler(host, { heartbeatMs: 0 });
  const res = await handler(new Request("http://localhost/a2canvas/events"));
  const reader = readerOf(res);
  await readView(reader); // initial empty snapshot
  host.ingest(up("agent:cog", 5));
  const view = (await readView(reader)) as { seq: number; lanes: { lane: string }[] };
  expect(view.seq).toBe(1);
  expect(view.lanes.map((l) => l.lane)).toEqual(["agent:cog"]);
  await reader.cancel();
});
