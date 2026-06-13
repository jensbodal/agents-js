import { describe, expect, test } from "bun:test";
import { mountDashboardSurface } from "../src/dashboard-controller.ts";

// ── dashboard-controller: renderer-agnostic RendererAdapter mount orchestration ──
// The seam the wasm-canvas viz panel (or any ADR-0009 RendererAdapter) plugs
// into. The dashboard's connected-agent surface + the wasm activity feed are
// covered by `dashboard-data.test.ts` (pure mappers).

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
