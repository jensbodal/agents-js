import { describe, expect, test } from "bun:test";
import {
  buildVizSurface,
  type DashboardAgent,
  fetchFleetCard,
  reduceHarnessEvent,
  seedState,
  toFleetView,
} from "../src/dashboard-data.ts";

// The wasm renderer's own catalog (distinct from the Lit dashboard, which uses
// plain DOM) — the viz panel uses container/layout primitives.
const WASM_CATALOG = new Set(["AcpColumn", "AcpRow", "AcpMessage", "AcpStatus"]);

describe("toFleetView — fleet state -> render-ready view-model", () => {
  test("summarizes ready/total and yields one row per agent", () => {
    const view = toFleetView(
      seedState([
        { id: "pi-acp", displayName: "pi-acp", primary: true, ready: true },
        { id: "opencode", displayName: "opencode", primary: false, ready: false },
      ]),
    );
    expect(view.summary).toBe("1/2 agents ready");
    expect(view.rows).toHaveLength(2);
    const pi = view.rows.find((r) => r.id === "pi-acp");
    expect(pi).toMatchObject({ ready: true, primary: true });
    const oc = view.rows.find((r) => r.id === "opencode");
    expect(oc).toMatchObject({ ready: false, primary: false });
  });

  test("empty fleet yields a non-blank empty-state summary and no rows", () => {
    const view = toFleetView(seedState([]));
    expect(view.rows).toHaveLength(0);
    expect(/no agents|empty/i.test(view.summary)).toBe(true);
  });
});

describe("buildVizSurface — wasm viz panel activity feed (pure)", () => {
  test("empty activity renders a non-blank idle marker", () => {
    const surface = buildVizSurface([]);
    expect(surface.root).toBeTruthy();
    const types = Object.values(surface.components).map((c) => c.type);
    for (const t of types) expect(WASM_CATALOG.has(t)).toBe(true);
    const text = JSON.stringify(surface.components);
    expect(/idle|waiting|activity/i.test(text)).toBe(true);
  });

  test("renders most-recent activity rows under a single root container", () => {
    const surface = buildVizSurface([
      "gateway.harness.child-spawned",
      "gateway.audit.a2a-task-finished",
    ]);
    const root = surface.components[surface.root];
    expect(root).toBeDefined();
    expect(root.type).toBe("AcpColumn");
    for (const childId of root.children ?? []) {
      expect(surface.components[childId]).toBeDefined();
    }
  });

  test("caps the feed so it cannot grow unbounded", () => {
    const many = Array.from({ length: 50 }, (_, i) => `evt-${i}`);
    const surface = buildVizSurface(many);
    const root = surface.components[surface.root];
    expect((root.children ?? []).length).toBeLessThanOrEqual(8);
  });
});

describe("reduceHarnessEvent — SSE topics over Map<id, agent>", () => {
  const base = seedState([{ id: "pi-acp", displayName: "pi-acp", primary: true, ready: true }]);

  test("child-spawned upserts a ready agent", () => {
    const next = reduceHarnessEvent(base, {
      type: "gateway.harness.child-spawned",
      payload: { harnessId: "opencode", harnessDisplayName: "opencode" },
    });
    expect(next.get("opencode")?.ready).toBe(true);
  });

  test("child-exited marks the agent down but keeps it listed", () => {
    const next = reduceHarnessEvent(base, {
      type: "gateway.harness.child-exited",
      payload: { harnessId: "pi-acp" },
    });
    expect(next.get("pi-acp")?.ready).toBe(false);
    expect(next.has("pi-acp")).toBe(true);
  });

  test("card-changed replaces the agent entry from newEntry", () => {
    const next = reduceHarnessEvent(base, {
      type: "gateway.harness.card-changed",
      payload: {
        harnessId: "pi-acp",
        newEntry: { id: "pi-acp", displayName: "pi-acp", primary: false, ready: false },
      },
    });
    expect(next.get("pi-acp")?.primary).toBe(false);
    expect(next.get("pi-acp")?.ready).toBe(false);
  });

  test("card-changed keys off harnessId, not newEntry.id (consistency)", () => {
    const next = reduceHarnessEvent(base, {
      type: "gateway.harness.card-changed",
      payload: {
        harnessId: "pi-acp",
        newEntry: { id: "WRONG", displayName: "pi-acp", primary: false, ready: true },
      },
    });
    expect(next.has("WRONG")).toBe(false);
    expect(next.get("pi-acp")?.id).toBe("pi-acp");
    expect(next.get("pi-acp")?.ready).toBe(true);
  });

  test("unknown event type returns the same state reference (no churn)", () => {
    const next = reduceHarnessEvent(base, { type: "gateway.audit.something", payload: {} });
    expect(next).toBe(base);
  });
});

describe("fetchFleetCard — agent-card.json -> discriminated union", () => {
  test("maps capabilities.harnesses[] to agents on success", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          capabilities: {
            harnesses: [
              { id: "pi-acp", displayName: "pi-acp", primary: true, ready: true },
              { id: "opencode", displayName: "opencode", primary: false, ready: false },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const result = await fetchFleetCard("https://gw.example", fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.agents.map((a: DashboardAgent) => a.id);
      expect(ids).toEqual(["pi-acp", "opencode"]);
    }
  });

  test("network failure returns {ok:false, error:'network-error'}", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await fetchFleetCard("https://gw.example", fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("network-error");
  });

  test("non-JSON body returns {ok:false, error:'invalid-response'}", async () => {
    const fetchImpl = (async () =>
      new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;
    const result = await fetchFleetCard("https://gw.example", fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid-response");
  });
});
