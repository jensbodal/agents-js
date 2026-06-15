import { expect, test } from "bun:test";
import type { A2CanvasAgentUpdate } from "../../a2canvas/src/index.ts";
import type { MatrixRoomEvent } from "../src/index.ts";
import { createPoller, type PlaneIssueSnapshot } from "../src/poller.ts";

const mev = (id: string, body = "hi"): MatrixRoomEvent => ({
  event_id: id,
  sender: "cognee-claude",
  timestamp: "2026-06-15T15:00:00Z",
  body,
});

const snap = (o: Partial<PlaneIssueSnapshot> & { stateName: string }): PlaneIssueSnapshot => ({
  sequenceId: 533,
  projectIdentifier: "DOT",
  issueName: "demo issue",
  actor: "cognee-claude",
  updatedAt: "2026-06-15T15:00:00Z",
  issueUrl: "https://plane.q4m.dev/dot/i/533",
  ...o,
});

function capture() {
  const out: A2CanvasAgentUpdate[] = [];
  return { ingest: (ev: A2CanvasAgentUpdate) => out.push(ev), out };
}

test("matrix: each event_id is ingested exactly once across polls", async () => {
  const c = capture();
  const events = [mev("$a"), mev("$b")];
  const poller = createPoller({
    fetchMatrixEvents: async () => events,
    fetchPlaneItems: async () => [],
    ingest: c.ingest,
  });
  expect(await poller.pollOnce()).toBe(2);
  expect(await poller.pollOnce()).toBe(0); // both already seen
  expect(c.out.map((u) => u.correlationId)).toEqual(["$a", "$b"]);
});

test("plane: first sighting is silent; only a state CHANGE ingests", async () => {
  const c = capture();
  let state = "Backlog";
  const poller = createPoller({
    fetchMatrixEvents: async () => [],
    fetchPlaneItems: async () => [snap({ stateName: state })],
    ingest: c.ingest,
  });
  expect(await poller.pollOnce()).toBe(0); // first sighting: recorded, not ingested
  expect(await poller.pollOnce()).toBe(0); // unchanged
  state = "In Progress";
  expect(await poller.pollOnce()).toBe(1); // transition
  const u = c.out[0];
  expect(u?.task.id).toBe("DOT-533");
  expect(u?.change.summary).toBe("Backlog → In Progress");
  state = "Done";
  expect(await poller.pollOnce()).toBe(1);
  expect(c.out[1]?.change.summary).toBe("In Progress → Done");
});

test("mixed sources count together; matrix opts flow through (roster host)", async () => {
  const c = capture();
  let planeState = "Backlog";
  const poller = createPoller({
    fetchMatrixEvents: async () => [mev("$x")],
    fetchPlaneItems: async () => [snap({ stateName: planeState })],
    ingest: c.ingest,
    matrixOpts: { roster: { "agent:cognee-claude": "malar" } },
  });
  // poll 1: matrix $x ingested (1), plane first-sight silent (0) => 1
  expect(await poller.pollOnce()).toBe(1);
  expect(c.out[0]?.host).toBe("malar"); // injected roster honored
  planeState = "In Progress";
  // poll 2: matrix $x dup (0), plane transition (1) => 1
  expect(await poller.pollOnce()).toBe(1);
});

test("start() polls on an interval and stop() halts it", async () => {
  const c = capture();
  let n = 0;
  const poller = createPoller({
    fetchMatrixEvents: async () => [mev(`$${n++}`)],
    fetchPlaneItems: async () => [],
    ingest: c.ingest,
  });
  const stop = poller.start(5);
  await new Promise((r) => setTimeout(r, 32));
  stop();
  const afterStop = c.out.length;
  await new Promise((r) => setTimeout(r, 20));
  expect(c.out.length).toBe(afterStop); // no further ingests after stop
  expect(afterStop).toBeGreaterThan(1); // polled multiple times
});
