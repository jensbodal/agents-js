import { expect, test } from "bun:test";
import {
  type A2CanvasAgentUpdate,
  applyA2CanvasUpdate,
  emptyBoard,
  isVerified,
  toA2CanvasView,
} from "../src/index.ts";

const up = (o: {
  id: string;
  ts: number;
  signed?: boolean;
  via?: "jwt" | "none";
  taskId?: string;
  summary?: string;
}): A2CanvasAgentUpdate => ({
  kind: "agent.update",
  principal: { id: o.id, signed: o.signed ?? true },
  host: "malar",
  task: { id: o.taskId, label: "build" },
  authority: { scopes: ["send_message"], assertedVia: o.via ?? "jwt" },
  change: { kind: "progress", summary: o.summary ?? "working" },
  ts: o.ts,
});

test("reducer adds an identity-true card (single entry point)", () => {
  const b = applyA2CanvasUpdate(
    emptyBoard(),
    up({ id: "agent:ajs", ts: 1, summary: "built core" }),
  );
  expect(b.cards.size).toBe(1);
  const c = [...b.cards.values()][0];
  expect(c?.principal.id).toBe("agent:ajs");
  expect(c?.change.summary).toBe("built core");
});

test("latest-wins; stale ignored (reducer owns order by ts)", () => {
  let b = applyA2CanvasUpdate(emptyBoard(), up({ id: "agent:ajs", ts: 5, summary: "working" }));
  b = applyA2CanvasUpdate(b, up({ id: "agent:ajs", ts: 10, summary: "done" }));
  b = applyA2CanvasUpdate(b, up({ id: "agent:ajs", ts: 3, summary: "stale" }));
  expect(b.cards.size).toBe(1);
  expect([...b.cards.values()][0]?.change.summary).toBe("done");
});

test("unsigned / non-jwt updates render as UNVERIFIED (identity-grounding visible)", () => {
  let b = applyA2CanvasUpdate(
    emptyBoard(),
    up({ id: "agent:real", ts: 1, signed: true, via: "jwt" }),
  );
  b = applyA2CanvasUpdate(b, up({ id: "agent:spoof", ts: 2, signed: false, via: "none" }));
  const cards = Object.fromEntries(
    [...b.cards.values()].map((c) => [c.principal.id, isVerified(c)]),
  );
  expect(cards["agent:real"]).toBe(true);
  expect(cards["agent:spoof"]).toBe(false); // spoofed = visibly untrusted, not a trusted card
});

test("two agents = two lanes, newest-first (M0 demo shape)", () => {
  let b = emptyBoard();
  b = applyA2CanvasUpdate(b, up({ id: "agent:ajs", ts: 1 }));
  b = applyA2CanvasUpdate(b, up({ id: "agent:cog", ts: 2 }));
  b = applyA2CanvasUpdate(b, up({ id: "agent:ajs", taskId: "x", ts: 3, summary: "newer" }));
  const v = toA2CanvasView(b);
  expect(v.lanes.map((l) => l.lane)).toEqual(["agent:ajs", "agent:cog"]);
  expect(v.lanes[0]?.cards[0]?.change.summary).toBe("newer"); // newest-first
});
