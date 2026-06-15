import { expect, test } from "bun:test";
import { createA2CanvasBoardHost } from "../src/board-host.ts";
import type { A2CanvasAgentUpdate } from "../src/index.ts";

const up = (id: string, ts: number, summary = "working"): A2CanvasAgentUpdate => ({
  kind: "agent.update",
  principal: { id, signed: true },
  host: "malar",
  task: { label: "build" },
  authority: { scopes: [], assertedVia: "jwt" },
  change: { kind: "progress", summary },
  ts,
});

test("ingest applies updates through the reducer; view reflects them", () => {
  const host = createA2CanvasBoardHost();
  host.ingest(up("agent:ajs", 1, "built core"));
  const v = host.view();
  expect(v.lanes).toHaveLength(1);
  expect(v.lanes[0]?.cards[0]?.change.summary).toBe("built core");
});

test("seq advances only on real change; stale ingest is a no-op", () => {
  const host = createA2CanvasBoardHost();
  host.ingest(up("agent:ajs", 10, "done"));
  const seqAfterFirst = host.view().seq;
  host.ingest(up("agent:ajs", 3, "stale")); // older ts → reducer ignores
  expect(host.view().seq).toBe(seqAfterFirst);
  expect(host.view().lanes[0]?.cards[0]?.change.summary).toBe("done");
});

test("subscribe is notified with the new view on each real change", () => {
  const host = createA2CanvasBoardHost();
  const seen: number[] = [];
  const unsub = host.subscribe((v) => seen.push(v.seq));
  host.ingest(up("agent:ajs", 1));
  host.ingest(up("agent:cog", 2));
  unsub();
  host.ingest(up("agent:ajs", 3)); // after unsub → not seen
  expect(seen).toEqual([1, 2]);
});

test("stale ingest does NOT notify subscribers (no spurious wakeups)", () => {
  const host = createA2CanvasBoardHost();
  host.ingest(up("agent:ajs", 10));
  let calls = 0;
  host.subscribe(() => calls++);
  host.ingest(up("agent:ajs", 5)); // stale
  expect(calls).toBe(0);
});

test("ingestAll applies a batch and notifies once per real change", () => {
  const host = createA2CanvasBoardHost();
  const seen: number[] = [];
  host.subscribe((v) => seen.push(v.seq));
  host.ingestAll([up("agent:ajs", 1), up("agent:cog", 2), up("agent:ajs", 1)]); // 3rd is stale dup
  expect(seen).toEqual([1, 2]);
  expect(host.view().lanes).toHaveLength(2);
});
