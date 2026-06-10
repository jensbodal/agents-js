/**
 * Behavioural validation of the RendererAdapter lifecycle contract via
 * the slot-2 prototype.
 *
 * Coverage:
 *  - mount/dispose required-by-contract paths
 *  - mount-twice throws
 *  - methods-before-mount throw (apply, resize, capture)
 *  - methods-after-dispose throw
 *  - dispose() idempotent (calling twice is a no-op)
 *  - apply discriminated-union: snapshot replaces state; delta adds/removes
 *  - capture unavailable when no frame applied; captured otherwise
 *  - stats safe to call before mount (returns phase "unmounted")
 *  - stats reflects phase + frame_count joinable
 *  - mount opts threaded (initialBgColor)
 *  - minimal adapter implements only mount + dispose successfully
 */

import { describe, expect, test } from "bun:test";

import {
  createMinimalPrototypeAdapter,
  createMockCanvasTarget,
  createPrototypeAdapter,
} from "../src/index.ts";

// ----------------------------------------------------------------------------
// Lifecycle required paths
// ----------------------------------------------------------------------------

describe("Full prototype adapter — lifecycle", () => {
  test("mount → apply snapshot → capture → dispose succeeds", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();

    await adapter.mount(target);
    await adapter.apply?.({
      kind: "snapshot",
      snapshot: { bgColor: "#abc", items: ["a", "b"] },
    });
    const captured = await adapter.capture?.();
    expect(captured?.kind).toBe("captured");
    if (captured?.kind === "captured") {
      const node = captured.artifact.canvas.nodes[0];
      expect(node?.type).toBe("text");
      expect(node?.text).toContain("a");
      expect(node?.text).toContain("b");
    }
    adapter.dispose();

    expect(target.ops).toEqual(["mount bg=#fff", "apply snapshot", "dispose"]);
  });

  test("mount opts: initialBgColor is threaded through", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();

    await adapter.mount(target, { initialBgColor: "#000" });
    expect(target.ops[0]).toBe("mount bg=#000");
  });
});

// ----------------------------------------------------------------------------
// Mount-twice / methods-before-mount / methods-after-dispose errors
// ----------------------------------------------------------------------------

describe("Full prototype adapter — ordering errors", () => {
  test("mount called twice throws", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);
    await expect(adapter.mount(target)).rejects.toThrow(/mount called twice/);
  });

  test("apply before mount throws", async () => {
    const adapter = createPrototypeAdapter();
    await expect(
      adapter.apply?.({
        kind: "snapshot",
        snapshot: { bgColor: "#fff", items: [] },
      }),
    ).rejects.toThrow(/apply called before mount/);
  });

  test("resize before mount throws", async () => {
    const adapter = createPrototypeAdapter();
    expect(() => adapter.resize?.({ width: 100, height: 200 })).toThrow(
      /resize called before mount/,
    );
  });

  test("capture before mount throws", async () => {
    const adapter = createPrototypeAdapter();
    expect(() => adapter.capture?.()).toThrow(/capture called before mount/);
  });

  test("apply after dispose throws", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);
    adapter.dispose();
    await expect(
      adapter.apply?.({
        kind: "snapshot",
        snapshot: { bgColor: "#fff", items: [] },
      }),
    ).rejects.toThrow(/apply called after dispose/);
  });

  test("resize after dispose throws", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);
    adapter.dispose();
    expect(() => adapter.resize?.({ width: 100, height: 200 })).toThrow(
      /resize called after dispose/,
    );
  });
});

// ----------------------------------------------------------------------------
// dispose() idempotency
// ----------------------------------------------------------------------------

describe("Full prototype adapter — dispose idempotency", () => {
  test("dispose called twice is a no-op", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);
    adapter.dispose();
    const opsAfterFirst = target.ops.length;
    adapter.dispose(); // second call — no-op
    expect(target.ops.length).toBe(opsAfterFirst);
  });

  test("dispose before mount succeeds + makes mount throw afterwards", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    adapter.dispose(); // disposed without ever mounting
    await expect(adapter.mount(target)).rejects.toThrow(/mount called after dispose/);
  });
});

// ----------------------------------------------------------------------------
// apply discriminated union
// ----------------------------------------------------------------------------

describe("Full prototype adapter — apply discriminated union", () => {
  test("snapshot replaces state", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);

    await adapter.apply?.({
      kind: "snapshot",
      snapshot: { bgColor: "#111", items: ["x", "y"] },
    });
    await adapter.apply?.({
      kind: "snapshot",
      snapshot: { bgColor: "#222", items: ["z"] },
    });
    expect(target.lastFrame).toContain("bg=#222");
    expect(target.lastFrame).toContain("items=[z]");
  });

  test("delta adds + removes items", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);

    await adapter.apply?.({
      kind: "snapshot",
      snapshot: { bgColor: "#fff", items: ["a", "b", "c"] },
    });
    await adapter.apply?.({
      kind: "delta",
      update: { added: ["d"], removed: ["b"] },
    });
    expect(target.lastFrame).toContain("items=[a,c,d]");
  });
});

// ----------------------------------------------------------------------------
// capture availability
// ----------------------------------------------------------------------------

describe("Full prototype adapter — capture binds canvas-model JSON Canvas", () => {
  test("capture before apply → unavailable", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);

    const result = await adapter.capture?.();
    expect(result?.kind).toBe("unavailable");
    if (result?.kind === "unavailable") {
      expect(result.reason).toContain("no frame applied yet");
    }
  });

  test("capture after apply → a real JSON Canvas document, not a string", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target, { surfaceId: "demo-surface" });
    adapter.resize?.({ width: 640, height: 480 });
    await adapter.apply?.({
      kind: "snapshot",
      snapshot: { bgColor: "#444", items: ["Hello", "World"] },
    });

    const result = await adapter.capture?.();
    expect(result?.kind).toBe("captured");
    if (result?.kind !== "captured") return;

    const artifact = result.artifact;
    // The whole point of the binding: capture() emits a structured durable
    // JSON Canvas document via @agents-js/canvas-model — NOT a text string.
    expect(typeof artifact).toBe("object");
    expect(Array.isArray(artifact.canvas.nodes)).toBe(true);
    expect(artifact.canvas.nodes).toHaveLength(1);

    const node = artifact.canvas.nodes[0];
    expect(node?.type).toBe("text");
    expect(node?.id).toBe("demo-surface");
    // Geometry threaded from the adapter's resize() viewport.
    expect(node?.width).toBe(640);
    expect(node?.height).toBe(480);
    // Item labels surface into the JSON Canvas preview text via canvas-model's
    // TEXT_KEYS harvest (the `text` field on each component).
    expect(node?.text).toContain("Hello");
    expect(node?.text).toContain("World");
  });

  test("capture preserves canvas-model's lossy-export warning (honest durability)", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target, { surfaceId: "warn-surface" });
    await adapter.apply?.({
      kind: "snapshot",
      snapshot: { bgColor: "#fff", items: ["x"] },
    });

    const result = await adapter.capture?.();
    expect(result?.kind).toBe("captured");
    if (result?.kind !== "captured") return;

    // JSON Canvas export is preview-only; canvas-model flags the lossiness.
    // We surface that warning verbatim rather than claiming lossless capture.
    expect(result.artifact.warnings).toHaveLength(1);
    expect(result.artifact.warnings[0]?.code).toBe("json-canvas-lossy-a2ui");
    expect(result.artifact.warnings[0]?.nodeId).toBe("warn-surface");
  });

  test("capture reflects the latest applied delta state", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);
    await adapter.apply?.({
      kind: "snapshot",
      snapshot: { bgColor: "#fff", items: ["a", "b", "c"] },
    });
    await adapter.apply?.({
      kind: "delta",
      update: { added: ["d"], removed: ["b"] },
    });

    const result = await adapter.capture?.();
    expect(result?.kind).toBe("captured");
    if (result?.kind !== "captured") return;

    const text = result.artifact.canvas.nodes[0]?.text ?? "";
    expect(text).toContain("a");
    expect(text).toContain("c");
    expect(text).toContain("d");
    expect(text).not.toContain("# warn"); // sanity: not the previous surface
  });
});

// ----------------------------------------------------------------------------
// stats safe-before-mount + joinable observability
// ----------------------------------------------------------------------------

describe("Full prototype adapter — stats", () => {
  test("stats before mount returns phase 'unmounted'", async () => {
    const adapter = createPrototypeAdapter();
    const stats = await adapter.stats?.();
    expect(stats?.phase).toBe("unmounted");
  });

  test("stats after mount returns phase 'mounted' + joinable IDs", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);
    const stats = await adapter.stats?.();
    expect(stats?.phase).toBe("mounted");
    expect(stats?.joins?.surface_id).toBe("prototype");
    expect(stats?.joins?.frame_count).toBe("0");
  });

  test("stats reflects frame_count after applies", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);
    await adapter.apply?.({
      kind: "snapshot",
      snapshot: { bgColor: "#fff", items: [] },
    });
    await adapter.apply?.({
      kind: "delta",
      update: { added: ["x"] },
    });
    const stats = await adapter.stats?.();
    expect(stats?.joins?.frame_count).toBe("2");
  });

  test("stats after dispose returns phase 'disposed'", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);
    adapter.dispose();
    const stats = await adapter.stats?.();
    expect(stats?.phase).toBe("disposed");
  });
});

// ----------------------------------------------------------------------------
// Resize
// ----------------------------------------------------------------------------

describe("Full prototype adapter — resize", () => {
  test("resize updates target dimensions + logs op", async () => {
    const adapter = createPrototypeAdapter();
    const target = createMockCanvasTarget();
    await adapter.mount(target);
    adapter.resize?.({ width: 800, height: 600, devicePixelRatio: 2 });
    expect(target.width).toBe(800);
    expect(target.height).toBe(600);
    expect(target.ops).toContain("resize 800x600");
  });
});

// ----------------------------------------------------------------------------
// Minimal adapter (mount + dispose only)
// ----------------------------------------------------------------------------

describe("Minimal prototype adapter", () => {
  test("mount + dispose succeeds, optional methods are absent", async () => {
    const adapter = createMinimalPrototypeAdapter();
    const target = createMockCanvasTarget();

    await adapter.mount(target);
    expect(target.ops).toEqual(["minimal-mount"]);

    // Optional methods are not implemented; calling via optional chain
    // is safe (returns undefined).
    expect(adapter.apply).toBeUndefined();
    expect(adapter.resize).toBeUndefined();
    expect(adapter.capture).toBeUndefined();
    expect(adapter.stats).toBeUndefined();

    adapter.dispose();
    expect(target.ops).toEqual(["minimal-mount", "minimal-dispose"]);
  });

  test("dispose without mount is safe", async () => {
    const adapter = createMinimalPrototypeAdapter();
    adapter.dispose(); // no throw
  });
});
