import { describe, expect, test } from "bun:test";
import type { AgentsA2uiExtension, AgentsProvenanceExtension, JsonObject } from "../src/index.ts";
import {
  AGENTS_A2UI_EXTENSION,
  AGENTS_PROVENANCE_EXTENSION,
  createA2uiCanvasNode,
  exportJsonCanvas,
  exportOcif,
  OCIF_VERSION_URI,
  toInertJson,
} from "../src/index.ts";

describe("@agents-js/canvas-model — A2UI canvas handoff", () => {
  // What: an A2UI surface can be wrapped as inert canvas-node data with provenance beside it.
  // Why: canvas hosts need a portable handoff format before identity and runtime write paths are finalized.
  test("wraps A2UI payloads as inert data with explicit provenance", () => {
    const node = createA2uiCanvasNode(
      {
        id: "run card",
        type: "AcpCard",
        onClick: () => "not serialized",
        components: [{ type: "AcpText", text: "Planner found a canvas handoff slice." }],
      },
      {
        provenance: {
          source: "unit-test",
          scenarioId: "handoff",
          ignoredCallback: () => "not serialized",
        },
      },
    );
    const a2ui = node.data.find((entry): entry is AgentsA2uiExtension => {
      return entry.type === AGENTS_A2UI_EXTENSION;
    });
    const provenance = node.data.find((entry): entry is AgentsProvenanceExtension => {
      return entry.type === AGENTS_PROVENANCE_EXTENSION;
    });

    expect(node.id).toBe("canvas-run-card");
    expect(node.kind).toBe("agents-js.a2ui");
    expect(a2ui?.inert).toBe(true);
    expect((a2ui?.payload as JsonObject).onClick).toBeUndefined();
    expect(provenance?.payload).toEqual({ source: "unit-test", scenarioId: "handoff" });
  });

  // What: non-JSON values are stripped or normalized before the payload crosses the canvas boundary.
  // Why: exported canvas documents must be safe to persist, diff, and replay without executing component code.
  test("sanitizes non-JSON payload fields before export", () => {
    const cyclic: Record<string, unknown> = { id: "cyclic", type: "AcpText" };
    cyclic.self = cyclic;

    expect(
      toInertJson({
        keep: "value",
        date: new Date("2026-05-17T12:00:00.000Z"),
        bigint: 42n,
        notFinite: Number.POSITIVE_INFINITY,
        fn: () => "drop",
        symbol: Symbol("drop"),
        nested: cyclic,
      }),
    ).toEqual({
      keep: "value",
      date: "2026-05-17T12:00:00.000Z",
      bigint: "42",
      notFinite: null,
      nested: {
        id: "cyclic",
        type: "AcpText",
        self: null,
      },
    });
  });

  // What: self-referential arrays are replaced with null at the recursive edge.
  // Why: A2UI payloads can contain arbitrary object graphs; array cycles must not crash export.
  test("sanitizes cyclic arrays without recursing forever", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);

    expect(toInertJson(cyclic)).toEqual([null]);
  });

  // What: the portable node exports to an OCIF-style document with separate A2UI and provenance extensions.
  // Why: preserving render payload and attribution as separate extensions keeps future identity binding additive.
  test("exports OCIF-style nodes with separate A2UI and provenance extensions", () => {
    const node = createA2uiCanvasNode(
      { id: "status-surface", type: "AcpMessage", text: "Run is ready for review." },
      {
        id: "handoff-status",
        position: { x: 24, y: 48 },
        size: { width: 320, height: 180 },
        provenance: { source: "unit-test", scenarioId: "agent-status" },
      },
    );
    const ocif = exportOcif([node]);

    expect(ocif.ocif).toBe(OCIF_VERSION_URI);
    expect(ocif.nodes[0]).toMatchObject({
      id: "handoff-status",
      position: [24, 48],
      size: [320, 180],
      resource: "handoff-status-resource",
    });
    expect(ocif.nodes[0]?.data.map((entry) => entry.type)).toEqual([
      AGENTS_A2UI_EXTENSION,
      AGENTS_PROVENANCE_EXTENSION,
    ]);
    expect(ocif.resources[0]?.representations[0]).toMatchObject({
      mimeType: "text/plain",
      content: expect.stringContaining("Run is ready for review."),
    });
    expect(ocif.schemas.map((schema) => schema.name)).toEqual([
      AGENTS_A2UI_EXTENSION,
      AGENTS_PROVENANCE_EXTENSION,
    ]);
  });

  // What: the portable node exports to JSON Canvas as a deterministic text-node preview with a warning.
  // Why: JSON Canvas cannot represent the interactive A2UI payload, so downgrade loss must be explicit.
  test("exports JSON Canvas previews with deterministic geometry and lossy warnings", () => {
    const node = createA2uiCanvasNode(
      { id: "status-surface", type: "AcpMessage", text: "Run is ready for review." },
      {
        id: "handoff-status",
        title: "Agent status",
        position: { x: 12.4, y: -5.6 },
        size: { width: 300.2, height: 160.8 },
      },
    );
    const result = exportJsonCanvas([node]);

    expect(result.canvas.nodes[0]).toMatchObject({
      id: "handoff-status",
      type: "text",
      text: expect.stringContaining("Run is ready for review."),
      x: 12,
      y: -6,
      width: 300,
      height: 161,
    });
    expect(result.canvas.edges).toEqual([]);
    expect(result.warnings).toEqual([
      {
        nodeId: "handoff-status",
        code: "json-canvas-lossy-a2ui",
        message:
          "JSON Canvas export is preview-only: interactive A2UI payload and provenance extensions are not representable in a text node.",
      },
    ]);
  });
});
