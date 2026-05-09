import { safeCustomElement } from "@agents-js/ui-components";
import { css, html, LitElement, nothing, type PropertyValues, svg, type TemplateResult } from "lit";
import { property, query, state } from "lit/decorators.js";

export type ArchitectureNodeColor = "brand" | "warning" | "success" | "danger";

export type ArchitectureSide = "top" | "right" | "bottom" | "left";

export interface ArchitectureGroupNode {
  id: string;
  type: "group";
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  color?: ArchitectureNodeColor;
}

export interface ArchitectureTextNode {
  id: string;
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color?: ArchitectureNodeColor;
}

export type ArchitectureNode = ArchitectureGroupNode | ArchitectureTextNode;

export interface ArchitectureEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: ArchitectureSide;
  toSide?: ArchitectureSide;
  label?: string;
  color?: ArchitectureNodeColor;
}

export interface ArchitectureCanvasDoc {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
}

interface CanvasProjection {
  bounds: Bounds;
  edges: ArchitectureEdge[];
  groupNodes: ArchitectureGroupNode[];
  nodesById: Map<string, ArchitectureNode>;
  textNodes: ArchitectureTextNode[];
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ViewportTransform {
  x: number;
  y: number;
  k: number;
}

export const ZOOM_MIN = 0.4;
export const ZOOM_MAX = 2.5;

/**
 * Anchor point on a node's perimeter for the given side. Edges are drawn
 * between perimeter midpoints; if a side isn't specified by the edge, the
 * caller picks one based on relative position. Pure: no DOM, no rounding.
 */
export function computeSidePoint(
  node: { x: number; y: number; width: number; height: number },
  side: ArchitectureSide,
): Point {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  switch (side) {
    case "top":
      return { x: cx, y: node.y };
    case "bottom":
      return { x: cx, y: node.y + node.height };
    case "left":
      return { x: node.x, y: cy };
    case "right":
      return { x: node.x + node.width, y: cy };
  }
}

/**
 * Cubic bezier `d` attribute between two anchor points. Control-point
 * offsets are perpendicular to each side, sized to ~half the line distance
 * (clamped to a minimum so close-together edges don't visually flatten).
 *
 * Returned as a string the SVG `<path>` consumes directly. Stable for the
 * same inputs so the unit test can golden-string it.
 */
export function computeEdgePath(
  from: Point,
  to: Point,
  fromSide: ArchitectureSide,
  toSide: ArchitectureSide,
): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // Half the distance, with a 40px floor so a short connector still curves.
  const offset = Math.max(40, dist / 2);
  const c1 = controlOffset(from, fromSide, offset);
  const c2 = controlOffset(to, toSide, offset);
  return `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`;
}

function controlOffset(point: Point, side: ArchitectureSide, magnitude: number): Point {
  switch (side) {
    case "top":
      return { x: point.x, y: point.y - magnitude };
    case "bottom":
      return { x: point.x, y: point.y + magnitude };
    case "left":
      return { x: point.x - magnitude, y: point.y };
    case "right":
      return { x: point.x + magnitude, y: point.y };
  }
}

export type MarkdownLine =
  | { type: "heading"; content: string }
  | { type: "para"; content: string }
  | { type: "list-item"; content: string }
  | { type: "blank" };

/**
 * Minimal markdown row parser for the text bodies inside canvas nodes.
 * Recognises `## heading`, `- list item`, blank lines, and paragraphs.
 * Inline formatting (bold/italic/code) is rendered by the host as text;
 * we deliberately don't touch it here so this stays a pure projection.
 */
export function parseMarkdownLines(text: string): MarkdownLine[] {
  const result: MarkdownLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0) {
      result.push({ type: "blank" });
      continue;
    }
    if (line.startsWith("## ")) {
      result.push({ type: "heading", content: line.slice(3) });
      continue;
    }
    if (line.startsWith("- ")) {
      result.push({ type: "list-item", content: line.slice(2) });
      continue;
    }
    result.push({ type: "para", content: line });
  }
  return result;
}

/**
 * Compute the axis-aligned bounding box of all nodes. Used to fit the
 * canvas to the viewport on first render and for clamping the pan/zoom
 * transform so the user can't lose the canvas off-screen.
 */
export function computeContentBounds(nodes: readonly ArchitectureNode[]): Bounds {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }
  return { minX, minY, maxX, maxY };
}

function projectCanvasDoc(doc: ArchitectureCanvasDoc): CanvasProjection {
  const nodesById = new Map<string, ArchitectureNode>();
  const groupNodes: ArchitectureGroupNode[] = [];
  const textNodes: ArchitectureTextNode[] = [];
  for (const node of doc.nodes) {
    nodesById.set(node.id, node);
    if (node.type === "group") {
      groupNodes.push(node);
    } else {
      textNodes.push(node);
    }
  }
  return {
    bounds: computeContentBounds(doc.nodes),
    edges: doc.edges,
    groupNodes,
    nodesById,
    textNodes,
  };
}

/**
 * Fit-to-viewport transform: pick the scale that fits the content bounds
 * inside the viewport (with a small margin), then center it. Used by the
 * "Reset view" button and on first mount.
 */
export function fitTransform(
  bounds: Bounds,
  viewport: { width: number; height: number },
  margin = 32,
): ViewportTransform {
  const contentW = bounds.maxX - bounds.minX;
  const contentH = bounds.maxY - bounds.minY;
  if (contentW <= 0 || contentH <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return { x: 0, y: 0, k: 1 };
  }
  const availableW = Math.max(1, viewport.width - margin * 2);
  const availableH = Math.max(1, viewport.height - margin * 2);
  const k = Math.min(availableW / contentW, availableH / contentH, ZOOM_MAX);
  const kFinal = Math.max(ZOOM_MIN, k);
  // Translate so bounds.min lands at (margin, margin) post-scale, then
  // shift to center any leftover slack.
  const slackX = (viewport.width - contentW * kFinal) / 2;
  const slackY = (viewport.height - contentH * kFinal) / 2;
  return {
    x: slackX - bounds.minX * kFinal,
    y: slackY - bounds.minY * kFinal,
    k: kFinal,
  };
}

/**
 * Clamp a pan/zoom transform so the content stays at least partially in
 * view. Uses a 50% overlap rule: at least half the viewport width/height
 * must overlap the content's transformed bounding box. Cheaper than a
 * full geometric overlap test and matches user intuition — the canvas
 * can't fully escape the visible area.
 */
export function clampViewport(
  t: ViewportTransform,
  bounds: Bounds,
  viewport: { width: number; height: number },
): ViewportTransform {
  const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, t.k));
  // Transformed content extent on screen.
  const screenMinX = bounds.minX * k + t.x;
  const screenMinY = bounds.minY * k + t.y;
  const screenMaxX = bounds.maxX * k + t.x;
  const screenMaxY = bounds.maxY * k + t.y;
  const contentW = screenMaxX - screenMinX;
  const contentH = screenMaxY - screenMinY;
  // Permit content to slide off until only half the viewport overlaps.
  const minVisibleX = viewport.width / 2;
  const minVisibleY = viewport.height / 2;
  // Maximum allowed translation: content's right edge can't be left of
  // `minVisibleX`; left edge can't be right of `viewport.width - minVisibleX`.
  const maxX = viewport.width - minVisibleX - bounds.minX * k;
  const minX = minVisibleX - bounds.maxX * k;
  const maxY = viewport.height - minVisibleY - bounds.minY * k;
  const minY = minVisibleY - bounds.maxY * k;
  // If content is smaller than half the viewport, the bounds invert; in
  // that case we don't clamp (any position keeps it visible).
  const newX = contentW < minVisibleX ? t.x : Math.max(minX, Math.min(maxX, t.x));
  const newY = contentH < minVisibleY ? t.y : Math.max(minY, Math.min(maxY, t.y));
  return { x: newX, y: newY, k };
}

/**
 * Apply a wheel-zoom step. Pivot is the cursor position in screen space;
 * we adjust translate so the world point under the cursor stays put.
 * Pure so the test can drive it without an actual WheelEvent.
 */
export function applyZoom(t: ViewportTransform, pivot: Point, factor: number): ViewportTransform {
  const kRaw = t.k * factor;
  const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, kRaw));
  // worldPoint = (pivot - translate) / k  (before)
  // we want worldPoint to be unchanged after the zoom:
  //   pivot = worldPoint * kNew + translateNew
  // → translateNew = pivot - worldPoint * kNew
  const worldX = (pivot.x - t.x) / t.k;
  const worldY = (pivot.y - t.y) / t.k;
  return { x: pivot.x - worldX * k, y: pivot.y - worldY * k, k };
}

/**
 * `<docs-canvas-viewer>` — interactive SVG architecture map.
 *
 * Receives an `ArchitectureCanvasDoc` via the `doc` property (set by the
 * Vue wrapper after fetching `architecture.canvas`). Renders groups +
 * text nodes + labelled edges with pan/zoom/select. All coordinates are
 * canvas-space; the `<g>` transform projects them to screen.
 */
@safeCustomElement("docs-canvas-viewer")
export class DocsCanvasViewer extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: relative;
      width: 100%;
      height: 600px;
      border: 1px solid var(--vp-c-divider, #ddd);
      border-radius: 8px;
      background: var(--vp-c-bg-soft, #fafafa);
      overflow: hidden;
      font-family: system-ui, sans-serif;
      --canvas-text-1: var(--vp-c-text-1, #222);
      --canvas-text-2: var(--vp-c-text-2, #777);
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
      cursor: grab;
      touch-action: none;
    }
    svg.panning {
      cursor: grabbing;
    }
    .group-rect {
      fill: var(--vp-c-bg-mute, #f0f0f0);
      stroke: var(--vp-c-divider, #ddd);
      stroke-width: 2;
      stroke-dasharray: 6 4;
      rx: 8;
    }
    .group-rect.brand {
      stroke: var(--vp-c-brand-1, #2c3e50);
      fill: var(--vp-c-brand-soft, #eef);
    }
    .group-rect.warning {
      stroke: var(--vp-c-warning-1, #806000);
      fill: var(--vp-c-warning-soft, #ffd);
    }
    .group-rect.success {
      stroke: var(--vp-c-success-1, #050);
      fill: var(--vp-c-success-soft, #efe);
    }
    .group-rect.danger {
      stroke: var(--vp-c-danger-1, #900);
      fill: var(--vp-c-danger-soft, #fee);
    }
    .group-label {
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.06em;
      fill: var(--canvas-text-2);
      text-transform: uppercase;
    }
    .text-rect {
      fill: var(--vp-c-bg, #fff);
      stroke: var(--vp-c-divider, #ddd);
      stroke-width: 1.5;
      rx: 6;
      cursor: pointer;
    }
    .text-rect.brand {
      stroke: var(--vp-c-brand-1, #2c3e50);
    }
    .text-rect.warning {
      stroke: var(--vp-c-warning-1, #806000);
    }
    .text-rect.success {
      stroke: var(--vp-c-success-1, #050);
    }
    .text-rect.danger {
      stroke: var(--vp-c-danger-1, #900);
    }
    .text-rect.selected {
      stroke-width: 3;
      filter: drop-shadow(0 0 4px var(--vp-c-brand-1, #2c3e50));
    }
    .text-body {
      font-family: var(--vp-font-family-base, system-ui, sans-serif);
      font-size: 13px;
      line-height: 1.45;
      color: var(--canvas-text-1);
      padding: 10px 14px;
      box-sizing: border-box;
      width: 100%;
      height: 100%;
      overflow: hidden;
      pointer-events: none;
    }
    .text-body h3 {
      margin: 0 0 6px;
      font-size: 14px;
      font-weight: 700;
      color: var(--canvas-text-1);
    }
    .text-body p {
      margin: 0 0 6px;
    }
    .text-body ul {
      margin: 0;
      padding-left: 18px;
    }
    .text-body li {
      margin: 0 0 2px;
    }
    .text-body code {
      background: var(--vp-c-bg-mute, #f0f0f0);
      padding: 0 4px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .edge {
      fill: none;
      stroke: var(--vp-c-text-2, #777);
      stroke-width: 2;
    }
    .edge-label {
      font-size: 11px;
      fill: var(--canvas-text-2);
      paint-order: stroke;
      stroke: var(--vp-c-bg-soft, #fafafa);
      stroke-width: 4;
    }
    .controls {
      position: absolute;
      top: 8px;
      right: 8px;
      display: flex;
      gap: 4px;
    }
    .controls button {
      font: inherit;
      font-size: 12px;
      padding: 4px 10px;
      border: 1px solid var(--vp-c-divider, #ddd);
      border-radius: 4px;
      background: var(--vp-c-bg, #fff);
      color: var(--vp-c-text-1, #222);
      cursor: pointer;
    }
    .controls button:hover {
      background: var(--vp-c-bg-mute, #f0f0f0);
    }
    .inspector {
      position: absolute;
      top: 8px;
      left: 8px;
      max-width: 280px;
      padding: 10px 12px;
      border: 1px solid var(--vp-c-divider, #ddd);
      border-radius: 6px;
      background: var(--vp-c-bg, #fff);
      font-size: 12px;
      color: var(--vp-c-text-1, #222);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
    }
    .inspector .insp-id {
      font-family: var(--vp-font-family-mono, monospace);
      font-weight: 700;
      margin-bottom: 4px;
    }
    .inspector .insp-meta {
      color: var(--canvas-text-2);
      font-family: var(--vp-font-family-mono, monospace);
      font-size: 11px;
      margin-bottom: 6px;
    }
    .inspector .insp-text {
      max-height: 160px;
      overflow-y: auto;
      white-space: pre-wrap;
      font-family: var(--vp-font-family-mono, monospace);
      font-size: 11px;
      color: var(--canvas-text-2);
    }
    .inspector .insp-close {
      float: right;
      font: inherit;
      font-size: 11px;
      background: none;
      border: 0;
      cursor: pointer;
      color: var(--canvas-text-2);
      padding: 0 0 0 8px;
    }
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--canvas-text-2);
      font-style: italic;
    }
  `;

  /**
   * The canvas document. Set imperatively by the Vue wrapper after the
   * runtime fetch resolves; if `null`, we render an empty placeholder.
   */
  @property({ attribute: false })
  accessor doc: ArchitectureCanvasDoc | null = null;

  @state()
  private accessor _transform: ViewportTransform = { x: 0, y: 0, k: 1 };

  @state()
  private accessor _selectedId: string | null = null;

  @state()
  private accessor _viewport: { width: number; height: number } = { width: 0, height: 0 };

  @query("svg")
  private accessor _svgEl: SVGSVGElement | null = null;

  private _panOrigin: { mouseX: number; mouseY: number; tx: number; ty: number } | null = null;
  private _isPanning = false;
  private _resizeObserver: ResizeObserver | null = null;
  private _observedSvgEl: SVGSVGElement | null = null;
  private _projection: CanvasProjection | null = null;
  private _projectionDoc: ArchitectureCanvasDoc | null = null;
  private _didFit = false;

  override connectedCallback(): void {
    super.connectedCallback();
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._measureViewport());
    }
    if (this.hasUpdated) {
      this._observeSvgIfNeeded();
      this._measureViewport();
    }
  }

  override disconnectedCallback(): void {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._observedSvgEl = null;
    super.disconnectedCallback();
  }

  override firstUpdated(): void {
    this._observeSvgIfNeeded();
    this._measureViewport();
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has("doc")) {
      this._projection = null;
      this._projectionDoc = null;
      this._didFit = false;
    }
    const observedSvg = this._observeSvgIfNeeded();
    if (
      observedSvg ||
      !this._resizeObserver ||
      this._viewport.width === 0 ||
      this._viewport.height === 0
    ) {
      this._measureViewport();
    }
    // First time we have both a doc and a non-zero viewport, fit-to-bounds.
    const projection = this._getProjection();
    if (!this._didFit && projection && this._viewport.width > 0 && this._viewport.height > 0) {
      this._didFit = true;
      this._transform = fitTransform(projection.bounds, this._viewport);
    }
  }

  private _getProjection(): CanvasProjection | null {
    if (!this.doc) {
      this._projection = null;
      this._projectionDoc = null;
      return null;
    }
    if (this._projection && this._projectionDoc === this.doc) {
      return this._projection;
    }
    this._projection = projectCanvasDoc(this.doc);
    this._projectionDoc = this.doc;
    return this._projection;
  }

  private _observeSvgIfNeeded(): boolean {
    const el = this._svgEl;
    if (!el || !this._resizeObserver || this._observedSvgEl === el) return false;
    if (this._observedSvgEl) {
      this._resizeObserver.unobserve(this._observedSvgEl);
    }
    this._resizeObserver.observe(el);
    this._observedSvgEl = el;
    return true;
  }

  private _measureViewport(): void {
    const el = this._svgEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (this._viewport.width === rect.width && this._viewport.height === rect.height) {
      return;
    }
    this._viewport = { width: rect.width, height: rect.height };
  }

  private _onWheel = (e: WheelEvent): void => {
    const projection = this._getProjection();
    if (!projection) return;
    e.preventDefault();
    const rect = this._svgEl?.getBoundingClientRect();
    if (!rect) return;
    const pivot = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // deltaY > 0 → scroll down → zoom out
    const factor = Math.exp(-e.deltaY * 0.001);
    const next = applyZoom(this._transform, pivot, factor);
    this._transform = clampViewport(next, projection.bounds, this._viewport);
  };

  private _onPointerDown = (e: PointerEvent): void => {
    const projection = this._getProjection();
    const target = e.target as Element | null;
    const nodeEl = target?.closest("[data-node-id]");
    if (nodeEl) {
      const id = nodeEl.getAttribute("data-node-id");
      if (id) {
        const node = projection?.nodesById.get(id);
        // Groups are containers — we don't select them, only their text children.
        if (node && node.type === "text") {
          this._selectedId = id;
          return;
        }
      }
    }
    // Otherwise: start a pan.
    if (!this._svgEl) return;
    this._svgEl.setPointerCapture(e.pointerId);
    this._isPanning = true;
    this._svgEl.classList.add("panning");
    this._panOrigin = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      tx: this._transform.x,
      ty: this._transform.y,
    };
  };

  private _onPointerMove = (e: PointerEvent): void => {
    const projection = this._getProjection();
    if (!this._isPanning || !this._panOrigin || !projection) return;
    const dx = e.clientX - this._panOrigin.mouseX;
    const dy = e.clientY - this._panOrigin.mouseY;
    const candidate = {
      x: this._panOrigin.tx + dx,
      y: this._panOrigin.ty + dy,
      k: this._transform.k,
    };
    this._transform = clampViewport(candidate, projection.bounds, this._viewport);
  };

  private _onPointerUp = (e: PointerEvent): void => {
    if (this._isPanning && this._svgEl) {
      this._svgEl.releasePointerCapture(e.pointerId);
      this._svgEl.classList.remove("panning");
    }
    this._isPanning = false;
    this._panOrigin = null;
  };

  private _resetView = (): void => {
    const projection = this._getProjection();
    if (!projection) return;
    this._transform = fitTransform(projection.bounds, this._viewport);
    this._selectedId = null;
  };

  private _closeInspector = (): void => {
    this._selectedId = null;
  };

  private _resolveAnchor(
    node: ArchitectureNode,
    side: ArchitectureSide | undefined,
    other: ArchitectureNode,
  ): { point: Point; side: ArchitectureSide } {
    if (side) {
      return { point: computeSidePoint(node, side), side };
    }
    // Auto-pick: the side facing `other`.
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    const ox = other.x + other.width / 2;
    const oy = other.y + other.height / 2;
    const dx = ox - cx;
    const dy = oy - cy;
    const auto: ArchitectureSide =
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
    return { point: computeSidePoint(node, auto), side: auto };
  }

  private _renderNode(n: ArchitectureNode): TemplateResult {
    const colorClass = n.color ?? "";
    if (n.type === "group") {
      return svg`
        <g data-node-id=${n.id}>
          <rect
            class="group-rect ${colorClass}"
            x=${n.x}
            y=${n.y}
            width=${n.width}
            height=${n.height}
          ></rect>
          <text class="group-label" x=${n.x + 16} y=${n.y + 22}>${n.label}</text>
        </g>
      `;
    }
    const isSelected = this._selectedId === n.id;
    const lines = parseMarkdownLines(n.text);
    return svg`
      <g data-node-id=${n.id}>
        <rect
          class="text-rect ${colorClass} ${isSelected ? "selected" : ""}"
          x=${n.x}
          y=${n.y}
          width=${n.width}
          height=${n.height}
        ></rect>
        <foreignObject x=${n.x} y=${n.y} width=${n.width} height=${n.height}>
          <div class="text-body" xmlns="http://www.w3.org/1999/xhtml">
            ${renderMarkdown(lines)}
          </div>
        </foreignObject>
      </g>
    `;
  }

  private _renderEdge(
    e: ArchitectureEdge,
    projection: CanvasProjection,
  ): TemplateResult | typeof nothing {
    const from = projection.nodesById.get(e.fromNode);
    const to = projection.nodesById.get(e.toNode);
    if (!from || !to) return nothing;
    const a = this._resolveAnchor(from, e.fromSide, to);
    const b = this._resolveAnchor(to, e.toSide, from);
    const path = computeEdgePath(a.point, b.point, a.side, b.side);
    const midX = (a.point.x + b.point.x) / 2;
    const midY = (a.point.y + b.point.y) / 2;
    return svg`
      <g data-edge-id=${e.id}>
        <path class="edge" d=${path} marker-end="url(#arrow)"></path>
        ${
          e.label
            ? svg`<text class="edge-label" x=${midX} y=${midY} text-anchor="middle">
              ${e.label}
            </text>`
            : nothing
        }
      </g>
    `;
  }

  private _renderInspector(projection: CanvasProjection): TemplateResult | typeof nothing {
    if (!this._selectedId) return nothing;
    const node = projection.nodesById.get(this._selectedId);
    if (!node || node.type !== "text") return nothing;
    return html`
      <aside class="inspector">
        <button class="insp-close" @click=${this._closeInspector} aria-label="Close">×</button>
        <div class="insp-id">${node.id}</div>
        <div class="insp-meta">
          x=${node.x} y=${node.y} · ${node.width}×${node.height}
        </div>
        <div class="insp-text">${node.text}</div>
      </aside>
    `;
  }

  override render(): TemplateResult {
    const projection = this._getProjection();
    if (!projection) {
      return html`<div class="empty">Loading architecture map…</div>`;
    }
    const t = this._transform;
    return html`
      <svg
        @wheel=${this._onWheel}
        @pointerdown=${this._onPointerDown}
        @pointermove=${this._onPointerMove}
        @pointerup=${this._onPointerUp}
        @pointercancel=${this._onPointerUp}
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--vp-c-text-2, #777)"></path>
          </marker>
        </defs>
        <g transform="translate(${t.x} ${t.y}) scale(${t.k})">
          ${projection.groupNodes.map((n) => this._renderNode(n))}
          ${projection.edges.map((e) => this._renderEdge(e, projection))}
          ${projection.textNodes.map((n) => this._renderNode(n))}
        </g>
      </svg>
      <div class="controls">
        <button @click=${this._resetView} title="Reset view">Reset</button>
      </div>
      ${this._renderInspector(projection)}
    `;
  }
}

function renderMarkdown(lines: readonly MarkdownLine[]): TemplateResult[] {
  const out: TemplateResult[] = [];
  let currentList: string[] | null = null;
  const flushList = (): void => {
    if (currentList) {
      const items = currentList;
      out.push(html`<ul>
        ${items.map((c) => html`<li>${renderInline(c)}</li>`)}
      </ul>`);
      currentList = null;
    }
  };
  for (const line of lines) {
    if (line.type === "list-item") {
      if (!currentList) currentList = [];
      currentList.push(line.content);
      continue;
    }
    flushList();
    if (line.type === "heading") {
      out.push(html`<h3>${renderInline(line.content)}</h3>`);
    } else if (line.type === "para") {
      out.push(html`<p>${renderInline(line.content)}</p>`);
    }
    // blank → just flushes; we don't emit a node for it (CSS gap handles it).
  }
  flushList();
  return out;
}

/**
 * Inline renderer for the narrow markdown subset the canvas uses:
 * `code spans` between backticks, *italic* between asterisks. Anything
 * else falls through as text. Kept intentionally tiny — rich rendering
 * lives in VitePress markdown, not in canvas nodes.
 */
function renderInline(text: string): TemplateResult[] {
  const parts: TemplateResult[] = [];
  let i = 0;
  let buf = "";
  const flushBuf = (): void => {
    if (buf.length > 0) {
      parts.push(html`${buf}`);
      buf = "";
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flushBuf();
        parts.push(html`<code>${text.slice(i + 1, end)}</code>`);
        i = end + 1;
        continue;
      }
    } else if (ch === "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i) {
        flushBuf();
        parts.push(html`<em>${text.slice(i + 1, end)}</em>`);
        i = end + 1;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flushBuf();
  return parts;
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-canvas-viewer": DocsCanvasViewer;
  }
}
