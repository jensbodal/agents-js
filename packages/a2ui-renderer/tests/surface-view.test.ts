import { describe, expect, test } from "bun:test";
import { ACP_CATALOG_ID } from "@agents-js/a2ui-types";
import {
  A2uiRendererError,
  type ComponentLike,
  renderSurface,
  type SurfaceGroupLike,
  type SurfaceLike,
} from "../src/index.ts";

/**
 * Walk a Lit TemplateResult's nested structure and concatenate every static
 * string. Nested results live in `values`, so we recurse.
 */
function flatten(tpl: unknown): string {
  if (!tpl || typeof tpl !== "object") return "";
  const t = tpl as { strings?: ReadonlyArray<string>; values?: unknown[] };
  if (!t.strings || !t.values) return "";
  let out = "";
  for (let i = 0; i < t.strings.length; i++) {
    out += t.strings[i];
    const v = t.values[i];
    if (Array.isArray(v)) {
      for (const entry of v) out += flatten(entry);
    } else if (v && typeof v === "object") {
      out += flatten(v);
    }
  }
  return out;
}

function makeComponent(
  id: string,
  type: string,
  properties: Record<string, unknown>,
): ComponentLike {
  return { id, type, properties };
}

function makeSurface(id: string, components: ComponentLike[]): SurfaceLike {
  const byId = new Map<string, ComponentLike>();
  for (const c of components) byId.set(c.id, c);
  return {
    id,
    componentsModel: {
      get entries() {
        return byId.entries();
      },
    },
  };
}

function makeGroup(surfaces: SurfaceLike[]): SurfaceGroupLike {
  const map = new Map<string, SurfaceLike>();
  for (const s of surfaces) map.set(s.id, s);
  return { surfacesMap: map };
}

describe("renderSurface", () => {
  test("empty surface group renders without throwing", () => {
    const group = makeGroup([]);
    const tpl = renderSurface(group, { catalogId: ACP_CATALOG_ID, onEvent: () => {} });
    expect(tpl).toBeDefined();
    expect(flatten(tpl)).not.toContain("acp-message");
  });

  test("single-surface, single-component tree renders the component", () => {
    const surface = makeSurface("s1", [
      makeComponent("m1", "AcpMessage", { role: "user", body: "hello" }),
    ]);
    const tpl = renderSurface(makeGroup([surface]), {
      catalogId: ACP_CATALOG_ID,
      onEvent: () => {},
    });
    const html = flatten(tpl);
    expect(html).toContain("<acp-message");
    expect(html).toContain("</acp-message>");
  });

  test("nested tree: ChatApp -> Transcript + PromptInput renders all three tags", () => {
    const surface = makeSurface("s1", [
      makeComponent("root", "AcpChatApp", {
        transcript: "tr",
        promptInput: "pi",
      }),
      makeComponent("tr", "AcpTranscript", { children: ["m1"] }),
      makeComponent("pi", "AcpPromptInput", {
        value: { path: "/input" },
        submit: "send",
      }),
      makeComponent("m1", "AcpMessage", { role: "agent", body: "hi" }),
    ]);

    const tpl = renderSurface(makeGroup([surface]), {
      catalogId: ACP_CATALOG_ID,
      onEvent: () => {},
    });
    const html = flatten(tpl);
    expect(html).toContain("<acp-chat-app");
    expect(html).toContain("<acp-transcript");
    expect(html).toContain("<acp-prompt-input");
    expect(html).toContain("<acp-message");
  });

  test("renders only the requested surfaceId when provided", () => {
    const a = makeSurface("a", [
      makeComponent("m", "AcpMessage", { role: "user", body: "from a" }),
    ]);
    const b = makeSurface("b", [makeComponent("m", "AcpStatusBar", { status: "from b" })]);
    const group = makeGroup([a, b]);
    const tpl = renderSurface(group, {
      catalogId: ACP_CATALOG_ID,
      onEvent: () => {},
      surfaceId: "b",
    });
    const html = flatten(tpl);
    expect(html).toContain("<acp-status-bar");
    expect(html).not.toContain("<acp-message");
  });

  test("unknown surfaceId throws A2uiRendererError", () => {
    const group = makeGroup([makeSurface("a", [])]);
    expect(() =>
      renderSurface(group, {
        catalogId: ACP_CATALOG_ID,
        onEvent: () => {},
        surfaceId: "does-not-exist",
      }),
    ).toThrow(A2uiRendererError);
  });

  test("unsupported catalog id throws A2uiRendererError", () => {
    const surface = makeSurface("s1", [
      makeComponent("m", "AcpMessage", { role: "user", body: "hi" }),
    ]);
    expect(() =>
      renderSurface(makeGroup([surface]), {
        catalogId: "https://example.invalid/catalog/other/0.1",
        onEvent: () => {},
      }),
    ).toThrow(A2uiRendererError);
  });
});
