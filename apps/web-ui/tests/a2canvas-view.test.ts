import { describe, expect, test } from "bun:test";
import { type A2CanvasAgentUpdate, applyA2CanvasUpdate, toA2CanvasView } from "@agents-js/a2canvas";
import { parseA2CanvasView, toViewerLanes } from "../src/a2canvas-view.ts";

interface Spec {
  id: string;
  signed: boolean;
  via: "jwt" | "none";
  ts: number;
}

const mk = (s: Spec): A2CanvasAgentUpdate => ({
  kind: "agent.update",
  principal: { id: s.id, signed: s.signed },
  host: "malar",
  task: { id: "t", label: "build" },
  authority: { scopes: [], assertedVia: s.via },
  change: { kind: "progress", summary: "working" },
  next: { actions: [{ label: "open", ref: "https://x/1" }] },
  ts: s.ts,
});

/** Build a deterministic board view from specs via the reducer. */
const view = (...specs: Spec[]) => {
  let board = { boardId: "default", cards: new Map(), seq: 0 };
  for (const s of specs) board = applyA2CanvasUpdate(board, mk(s));
  return toA2CanvasView(board);
};

describe("parseA2CanvasView", () => {
  test("parses a valid view frame", () => {
    const v = view({ id: "agent:ajs", signed: true, via: "jwt", ts: 1 });
    const parsed = parseA2CanvasView(JSON.stringify(v));
    expect(parsed?.lanes[0]?.lane).toBe("agent:ajs");
  });

  test("returns null on malformed JSON (no throw — viewer stays alive)", () => {
    expect(parseA2CanvasView("{not json")).toBeNull();
  });

  test("returns null when the shape is wrong (missing lanes)", () => {
    expect(parseA2CanvasView(JSON.stringify({ boardId: "x", seq: 0 }))).toBeNull();
  });
});

describe("toViewerLanes — identity grounding is visible", () => {
  test("signed + jwt card renders verified; unsigned/none renders unverified", () => {
    const v = view(
      { id: "agent:real", signed: true, via: "jwt", ts: 1 },
      { id: "agent:spoof", signed: false, via: "none", ts: 2 },
    );
    const byLane = Object.fromEntries(toViewerLanes(v).map((l) => [l.lane, l.cards[0]?.verified]));
    expect(byLane["agent:real"]).toBe(true);
    expect(byLane["agent:spoof"]).toBe(false); // spoof is visibly untrusted
  });

  test("card display carries the M0 fields (who/host/task/summary/actions)", () => {
    const v = view({ id: "agent:ajs", signed: true, via: "jwt", ts: 1 });
    const card = toViewerLanes(v)[0]?.cards[0];
    expect(card?.who).toBe("agent:ajs");
    expect(card?.host).toBe("malar");
    expect(card?.task).toBe("build");
    expect(card?.summary).toBe("working");
    expect(card?.actions).toEqual([{ label: "open", ref: "https://x/1" }]);
  });
});
