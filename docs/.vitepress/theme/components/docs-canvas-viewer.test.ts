/**
 * Tests for `<docs-canvas-viewer>` — pure projection + clamping helpers,
 * plus a single element-level test using the Object.create-prototype
 * pattern (no DOM mounting). Mirrors the harness in docs-trace-inspector.
 */
import { describe, expect, test } from "bun:test";
import {
  type ArchitectureCanvasDoc,
  type ArchitectureNode,
  applyZoom,
  clampViewport,
  computeContentBounds,
  computeEdgePath,
  computeSidePoint,
  DocsCanvasViewer,
  fitTransform,
  parseMarkdownLines,
  ZOOM_MAX,
  ZOOM_MIN,
} from "./docs-canvas-viewer.ts";

function instance(): DocsCanvasViewer {
  return Object.create(DocsCanvasViewer.prototype) as DocsCanvasViewer;
}

const sampleNode = { x: 10, y: 20, width: 100, height: 60 };
const litSvgTemplateType = 2;

function litTemplateType(result: unknown): number | undefined {
  return (result as { _$litType$?: number })._$litType$;
}

describe("computeSidePoint", () => {
  test("top is mid-x at min-y", () => {
    expect(computeSidePoint(sampleNode, "top")).toEqual({ x: 60, y: 20 });
  });
  test("bottom is mid-x at max-y", () => {
    expect(computeSidePoint(sampleNode, "bottom")).toEqual({ x: 60, y: 80 });
  });
  test("left is min-x at mid-y", () => {
    expect(computeSidePoint(sampleNode, "left")).toEqual({ x: 10, y: 50 });
  });
  test("right is max-x at mid-y", () => {
    expect(computeSidePoint(sampleNode, "right")).toEqual({ x: 110, y: 50 });
  });
});

describe("computeEdgePath", () => {
  test("vertical bottom→top emits a downward-curving cubic", () => {
    const path = computeEdgePath({ x: 100, y: 100 }, { x: 100, y: 200 }, "bottom", "top");
    // Stable golden — regression guard against accidental control-point math drift.
    expect(path).toBe("M 100 100 C 100 150, 100 150, 100 200");
  });

  test("control offset has a 40px floor for short connectors", () => {
    // 10px apart: half-distance is 5, but the floor is 40, so control points
    // are 40 from each endpoint along their side normal.
    const path = computeEdgePath({ x: 0, y: 0 }, { x: 0, y: 10 }, "bottom", "top");
    expect(path).toBe("M 0 0 C 0 40, 0 -30, 0 10");
  });
});

describe("parseMarkdownLines", () => {
  test("classifies headings, paragraphs, list items, and blanks", () => {
    const text = ["## Heading", "", "Some paragraph text.", "- first", "- second"].join("\n");
    expect(parseMarkdownLines(text)).toEqual([
      { type: "heading", content: "Heading" },
      { type: "blank" },
      { type: "para", content: "Some paragraph text." },
      { type: "list-item", content: "first" },
      { type: "list-item", content: "second" },
    ]);
  });

  test("trims trailing whitespace on each line", () => {
    expect(parseMarkdownLines("- item   \n")).toEqual([
      { type: "list-item", content: "item" },
      { type: "blank" },
    ]);
  });

  test("does not strip inline markers in heading content", () => {
    expect(parseMarkdownLines("## hello `world`")).toEqual([
      { type: "heading", content: "hello `world`" },
    ]);
  });
});

describe("computeContentBounds", () => {
  test("union of all node rects", () => {
    const nodes: ArchitectureNode[] = [
      { id: "a", type: "text", x: 0, y: 0, width: 50, height: 30, text: "" },
      { id: "b", type: "text", x: 100, y: 200, width: 80, height: 40, text: "" },
    ];
    expect(computeContentBounds(nodes)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 180,
      maxY: 240,
    });
  });

  test("empty input returns zero bounds", () => {
    expect(computeContentBounds([])).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe("fitTransform", () => {
  test("scales content to fit viewport with margin and centers it", () => {
    const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 500 };
    const t = fitTransform(bounds, { width: 600, height: 400 }, 32);
    // available 536x336 → kx=0.536, ky=0.672 → k=0.536, clamped within [ZOOM_MIN, ZOOM_MAX]
    expect(t.k).toBeCloseTo(0.536, 3);
    // centered: slack = (600 - 1000*0.536)/2 = 32, slack y = (400 - 500*0.536)/2 = 66
    expect(t.x).toBeCloseTo(32, 3);
    expect(t.y).toBeCloseTo(66, 3);
  });

  test("clamps to ZOOM_MIN when content is much larger than viewport", () => {
    const bounds = { minX: 0, minY: 0, maxX: 100000, maxY: 100000 };
    const t = fitTransform(bounds, { width: 100, height: 100 });
    expect(t.k).toBe(ZOOM_MIN);
  });

  test("clamps to ZOOM_MAX when content is much smaller than viewport", () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const t = fitTransform(bounds, { width: 1000, height: 1000 });
    expect(t.k).toBe(ZOOM_MAX);
  });

  test("returns identity for zero-size viewport", () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    expect(fitTransform(bounds, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, k: 1 });
  });
});

describe("clampViewport", () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 500 };
  const viewport = { width: 800, height: 400 };

  test("clamps zoom to [ZOOM_MIN, ZOOM_MAX]", () => {
    expect(clampViewport({ x: 0, y: 0, k: 100 }, bounds, viewport).k).toBe(ZOOM_MAX);
    expect(clampViewport({ x: 0, y: 0, k: 0.001 }, bounds, viewport).k).toBe(ZOOM_MIN);
  });

  test("identity transform keeps the canvas overlapping the viewport", () => {
    const result = clampViewport({ x: 0, y: 0, k: 1 }, bounds, viewport);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
    expect(result.k).toBe(1);
  });

  test("pans that fully escape the viewport are clamped back", () => {
    // pan way to the right — the canvas left edge would exit the viewport.
    const result = clampViewport({ x: 10000, y: 0, k: 1 }, bounds, viewport);
    // After clamp, the canvas right edge must remain at least viewport.width/2
    // inside the viewport (i.e., screenMaxX >= viewport.width/2).
    const screenMaxX = bounds.maxX * result.k + result.x;
    expect(screenMaxX).toBeGreaterThanOrEqual(viewport.width / 2 - 0.001);
  });
});

describe("applyZoom", () => {
  test("zooming around a pivot keeps the world point under the pivot", () => {
    const before = { x: 100, y: 50, k: 1 };
    const pivot = { x: 200, y: 100 };
    // World point under cursor before:
    const worldBefore = { x: (pivot.x - before.x) / before.k, y: (pivot.y - before.y) / before.k };
    const after = applyZoom(before, pivot, 1.5);
    const worldAfter = { x: (pivot.x - after.x) / after.k, y: (pivot.y - after.y) / after.k };
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
  });

  test("clamps zoom-out at ZOOM_MIN", () => {
    const after = applyZoom({ x: 0, y: 0, k: ZOOM_MIN + 0.01 }, { x: 0, y: 0 }, 0.0001);
    expect(after.k).toBe(ZOOM_MIN);
  });

  test("clamps zoom-in at ZOOM_MAX", () => {
    const after = applyZoom({ x: 0, y: 0, k: ZOOM_MAX - 0.01 }, { x: 0, y: 0 }, 1000);
    expect(after.k).toBe(ZOOM_MAX);
  });
});

describe("DocsCanvasViewer (Object.create harness)", () => {
  function makeDoc(): ArchitectureCanvasDoc {
    return {
      nodes: [
        { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "alpha" },
        { id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "beta" },
      ],
      edges: [{ id: "ab", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" }],
    };
  }

  test("render returns a loading placeholder when doc is null", () => {
    const inst = instance();
    Object.defineProperty(inst, "doc", { value: null, writable: true });
    Object.defineProperty(inst, "_transform", {
      value: { x: 0, y: 0, k: 1 },
      writable: true,
    });
    Object.defineProperty(inst, "_selectedId", { value: null, writable: true });
    const result = inst.render();
    // TemplateResult exposes its strings; the loading copy should appear.
    const tplStrings = (result as unknown as { strings: readonly string[] }).strings.join("");
    expect(tplStrings).toContain("Loading architecture map");
  });

  test("render emits SVG defs + transform g when a doc is present", () => {
    const inst = instance();
    Object.defineProperty(inst, "doc", { value: makeDoc(), writable: true });
    Object.defineProperty(inst, "_transform", {
      value: { x: 10, y: 20, k: 1.5 },
      writable: true,
    });
    Object.defineProperty(inst, "_selectedId", { value: null, writable: true });
    const result = inst.render();
    const tplStrings = (result as unknown as { strings: readonly string[] }).strings.join("");
    expect(tplStrings).toContain("<svg");
    expect(tplStrings).toContain('id="arrow"');
    expect(tplStrings).toContain('transform="translate(');
  });

  test("node and edge fragments are SVG templates", () => {
    // WHAT: node and edge fragments interpolated under the root <svg> must use
    // Lit's SVG template mode, not HTML template mode.
    // WHY: Chrome renders HTML-namespace G/RECT/TEXT fragments inside an SVG as
    // zero-size boxes, which made the architecture canvas visually blank.
    const inst = instance();
    const doc = makeDoc();
    Object.defineProperty(inst, "doc", { value: doc, writable: true });
    Object.defineProperty(inst, "_selectedId", { value: null, writable: true });
    const renderNode = (
      inst as unknown as { _renderNode(node: ArchitectureNode): unknown }
    )._renderNode.bind(inst);
    const projection = (inst as unknown as { _getProjection(): unknown })._getProjection.call(inst);
    const renderEdge = (
      inst as unknown as {
        _renderEdge(edge: ArchitectureCanvasDoc["edges"][number], projection: unknown): unknown;
      }
    )._renderEdge.bind(inst);

    expect(litTemplateType(renderNode(doc.nodes[0]))).toBe(litSvgTemplateType);
    expect(litTemplateType(renderEdge(doc.edges[0], projection))).toBe(litSvgTemplateType);
  });

  test("resize observer attaches when the svg appears after the first update", () => {
    // WHAT: the resize observer should observe the current SVG exactly once,
    // including when that SVG appears only after the async canvas doc loads.
    // WHY: `firstUpdated` can run while the element still renders its loading
    // placeholder; without a later observe pass, viewport changes after load do
    // not refit or clamp against the current visible size.
    const inst = instance();
    const svgA = {} as SVGSVGElement;
    const svgB = {} as SVGSVGElement;
    const observed: SVGSVGElement[] = [];
    const unobserved: SVGSVGElement[] = [];
    const observer = {
      observe(el: Element) {
        observed.push(el as SVGSVGElement);
      },
      unobserve(el: Element) {
        unobserved.push(el as SVGSVGElement);
      },
    } as ResizeObserver;

    let currentSvg = svgA;
    Object.defineProperty(inst, "_svgEl", { get: () => currentSvg, configurable: true });
    Object.defineProperty(inst, "_resizeObserver", { value: observer, writable: true });
    Object.defineProperty(inst, "_observedSvgEl", { value: null, writable: true });

    const observeSvgIfNeeded = (
      inst as unknown as { _observeSvgIfNeeded(): boolean }
    )._observeSvgIfNeeded.bind(inst);
    expect(observeSvgIfNeeded()).toBe(true);
    expect(observeSvgIfNeeded()).toBe(false);
    currentSvg = svgB;
    expect(observeSvgIfNeeded()).toBe(true);

    expect(observed).toEqual([svgA, svgB]);
    expect(unobserved).toEqual([svgA]);
  });
});
