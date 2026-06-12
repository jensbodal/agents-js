import { describe, expect, test } from "bun:test";
import { mountDashboardSurface } from "../src/dashboard-controller.ts";
import { buildDashboardSurface, DASHBOARD_SURFACE_ID } from "../src/dashboard-surface.ts";

// ── dashboard-surface: the empty dashboard A2UI payload (mirrors landing-surface) ──
describe("gateway dashboard surface", () => {
  test("creates a single dashboard surface that starts empty (M0)", () => {
    const messages = buildDashboardSurface();

    const create = messages.find((m) => "createSurface" in m);
    expect(create?.createSurface?.surfaceId).toBe(DASHBOARD_SURFACE_ID);

    // "Empty" per Jens's M0: the initial surface carries only an empty-state
    // marker — no agent/registry/health content yet (that's layered on later).
    const update = messages.find((m) => "updateComponents" in m);
    expect(update?.updateComponents?.surfaceId).toBe(DASHBOARD_SURFACE_ID);
    const components = update?.updateComponents?.components ?? [];
    expect(components.length).toBe(1);
  });

  test("every message targets the same surface id", () => {
    for (const message of buildDashboardSurface()) {
      const id = message.createSurface?.surfaceId ?? message.updateComponents?.surfaceId ?? null;
      expect(id).toBe(DASHBOARD_SURFACE_ID);
    }
  });
});

// ── dashboard-controller: renderer-agnostic RendererAdapter mount orchestration ──
// The seam the wasm-canvas adapter (or any RendererAdapter) plugs into.

function makeRecordingAdapter() {
  const calls: string[] = [];
  let phase: "unmounted" | "mounted" | "disposed" = "unmounted";
  const adapter = {
    async mount(target: { tagName?: string }) {
      calls.push(`mount:${target?.tagName ?? "?"}`);
      phase = "mounted";
    },
    async apply(payload: { kind: string }) {
      calls.push(`apply:${payload.kind}`);
    },
    async dispose() {
      calls.push("dispose");
      phase = "disposed";
    },
    stats() {
      return { phase };
    },
  };
  return { adapter, calls };
}

describe("mountDashboardSurface — renderer-agnostic seam", () => {
  test("mounts the adapter onto the canvas, then applies the surface snapshot", async () => {
    const { adapter, calls } = makeRecordingAdapter();
    const canvas = { tagName: "CANVAS" } as unknown as HTMLCanvasElement;

    // biome-ignore lint/suspicious/noExplicitAny: test double for the generic adapter seam
    const handle = await mountDashboardSurface(adapter as any, canvas, { surface: "empty" });
    expect(calls).toEqual(["mount:CANVAS", "apply:snapshot"]);

    await handle.dispose();
    expect(calls).toEqual(["mount:CANVAS", "apply:snapshot", "dispose"]);
  });

  test("supports a minimal adapter that omits apply (empty canvas, no surface applied)", async () => {
    const calls: string[] = [];
    const minimal = {
      async mount() {
        calls.push("mount");
      },
      async dispose() {
        calls.push("dispose");
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: minimal mount+dispose adapter
    const handle = await mountDashboardSurface(minimal as any, {} as HTMLCanvasElement, null);
    expect(calls).toEqual(["mount"]); // no apply() → canvas stays empty
    await handle.dispose();
    expect(calls).toEqual(["mount", "dispose"]);
  });
});
