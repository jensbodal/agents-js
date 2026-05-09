/**
 * Element-level tests for `<docs-manifest-editor>`.
 *
 * Strategy mirrors the chat-pane / trace-inspector suites: the render
 * branching is exercised against a pure helper (`renderManifestEditor`)
 * driven by a plain input struct, while event-handler dispatch is checked
 * against `Object.create(...)`-staged instances. Bun's runtime has no DOM,
 * so we never go through Lit's reactive accessor machinery.
 */
import { describe, expect, test } from "bun:test";
import {
  createManifestValidator,
  type ManifestDraft,
  type ManifestValidator,
  type PlaygroundState,
} from "@agents-js/browser-runtime";
import {
  DocsManifestEditor,
  isManifestDirty,
  RUNTIME_OPTIONS,
  renderManifestEditor,
} from "./docs-manifest-editor.ts";

function instance(): DocsManifestEditor {
  return Object.create(DocsManifestEditor.prototype) as DocsManifestEditor;
}

const noopValidator: ManifestValidator = () => ({ valid: true });

const noopHandlers = {
  onPatch: (_p: Partial<ManifestDraft>): void => {},
  onApply: (): void => {},
};

const BASE_DRAFT: ManifestDraft = {
  name: "docs-meta-agent",
  runtime: "local-wasm-worker",
  permissions: "explicit",
  tools: [{ name: "searchDocs", allow: true }],
};

function makeState(overrides: {
  manifest?: ManifestDraft;
  manifestDraft?: ManifestDraft;
}): PlaygroundState {
  const manifest = overrides.manifest ?? BASE_DRAFT;
  const manifestDraft = overrides.manifestDraft ?? manifest;
  return {
    ui: { activeTab: "manifest", theme: "light" },
    manifest,
    manifestDraft,
    runs: new Map(),
    activeRunId: null,
    replayMode: null,
  };
}

interface MaybeTemplateResult {
  strings?: readonly string[];
  values?: readonly unknown[];
}

function collectAllStrings(node: MaybeTemplateResult | unknown): string {
  if (Array.isArray(node)) {
    let out = "";
    for (const child of node) out += collectAllStrings(child);
    return out;
  }
  if (typeof node !== "object" || node === null) return "";
  const t = node as MaybeTemplateResult;
  let out = "";
  if (Array.isArray(t.strings)) out += t.strings.join("");
  if (Array.isArray(t.values)) {
    for (const v of t.values) out += collectAllStrings(v);
  }
  return out;
}

function flattenTemplateValues(values: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    if (typeof v === "object" && v !== null && "values" in v && Array.isArray(v.values)) {
      out.push(...flattenTemplateValues(v.values));
    } else {
      out.push(v);
    }
  }
  return out;
}

describe("RUNTIME_OPTIONS — selector contract", () => {
  test("includes mock and local-wasm-worker as enabled options", () => {
    const enabled = RUNTIME_OPTIONS.filter((o) => !o.disabled).map((o) => o.value);
    expect(enabled).toContain("mock");
    expect(enabled).toContain("local-wasm-worker");
  });

  test("includes agents-js-gateway as a disabled coming-soon option", () => {
    // Disabling the option in the form is the safety rail that prevents
    // users from dispatching APPLY_MANIFEST with a runtime the shell has
    // no factory for. The schema still validates this value (it's reserved
    // for future gateway adapters); the form just refuses to surface it as a live choice.
    const gateway = RUNTIME_OPTIONS.find((o) => o.value === "agents-js-gateway");
    expect(gateway).toBeDefined();
    expect(gateway?.disabled).toBe(true);
  });
});

describe("isManifestDirty — diff helper", () => {
  test("returns false when applied manifest deep-equals draft", () => {
    expect(isManifestDirty(BASE_DRAFT, BASE_DRAFT)).toBe(false);
    // Same-shape object literal also reads as clean — the helper compares
    // values, not references. (Otherwise every reducer rebuild would flag
    // dirty falsely.)
    expect(
      isManifestDirty(BASE_DRAFT, {
        name: "docs-meta-agent",
        runtime: "local-wasm-worker",
        permissions: "explicit",
        tools: [{ name: "searchDocs", allow: true }],
      }),
    ).toBe(false);
  });

  test("returns true when name differs", () => {
    expect(isManifestDirty(BASE_DRAFT, { ...BASE_DRAFT, name: "different" })).toBe(true);
  });

  test("returns true when runtime differs", () => {
    expect(isManifestDirty(BASE_DRAFT, { ...BASE_DRAFT, runtime: "mock" })).toBe(true);
  });

  test("returns true when permissions differ", () => {
    expect(isManifestDirty(BASE_DRAFT, { ...BASE_DRAFT, permissions: "yolo" })).toBe(true);
  });

  test("returns true when tools differ in length", () => {
    expect(isManifestDirty(BASE_DRAFT, { ...BASE_DRAFT, tools: [] })).toBe(true);
  });

  test("returns true when first-tool name differs", () => {
    expect(
      isManifestDirty(BASE_DRAFT, {
        ...BASE_DRAFT,
        tools: [{ name: "renamedTool", allow: true }],
      }),
    ).toBe(true);
  });

  test("returns true when first-tool allow differs", () => {
    expect(
      isManifestDirty(BASE_DRAFT, {
        ...BASE_DRAFT,
        tools: [{ name: "searchDocs", allow: false }],
      }),
    ).toBe(true);
  });
});

describe("renderManifestEditor — empty/null state", () => {
  test("renders an empty notice when state is null (no draft to edit yet)", () => {
    const result = renderManifestEditor({
      state: null,
      validator: noopValidator,
      validationErrors: null,
      ...noopHandlers,
    });
    expect(collectAllStrings(result)).toContain("No manifest available");
  });
});

describe("renderManifestEditor — populated state", () => {
  test("emits each input row + the YAML preview + validate-and-apply button", () => {
    const result = renderManifestEditor({
      state: makeState({}),
      validator: noopValidator,
      validationErrors: null,
      ...noopHandlers,
    });
    const flat = collectAllStrings(result);
    // The element renders one input/select per editable field plus a YAML
    // preview that prints the active draft. The structural hooks must show
    // up so a future markup refactor that drops a row trips this guard.
    expect(flat).toContain("name");
    expect(flat).toContain("runtime");
    expect(flat).toContain("permissions");
    expect(flat).toContain("Validate & Apply");
    // YAML preview text — `renderManifestAsYaml` emits `runtime: <id>`.
    // The interpolated YAML lands in template `values`, not in the static
    // `strings` array; flatten everything to find it.
    const allValues = flattenTemplateValues(result.values ?? []);
    const flatJson = JSON.stringify(allValues);
    expect(flatJson).toContain("runtime:");
  });

  test("renders the dirty indicator when draft differs from applied manifest", () => {
    const result = renderManifestEditor({
      state: makeState({
        manifest: BASE_DRAFT,
        manifestDraft: { ...BASE_DRAFT, name: "draft-edit" },
      }),
      validator: noopValidator,
      validationErrors: null,
      ...noopHandlers,
    });
    expect(collectAllStrings(result)).toContain("Unsaved");
  });

  test("does NOT render the dirty indicator when draft matches applied manifest", () => {
    const result = renderManifestEditor({
      state: makeState({}),
      validator: noopValidator,
      validationErrors: null,
      ...noopHandlers,
    });
    expect(collectAllStrings(result)).not.toContain("Unsaved");
  });

  test("renders validation errors inline when validationErrors is non-empty", () => {
    const result = renderManifestEditor({
      state: makeState({}),
      validator: noopValidator,
      validationErrors: ["$ name minLength: must be longer", "$.tools type: must be array"],
      ...noopHandlers,
    });
    const allValues = flattenTemplateValues(result.values ?? []);
    const flat = JSON.stringify(allValues);
    expect(flat).toContain("must be longer");
    expect(flat).toContain("must be array");
  });

  test("does NOT render an errors block when validationErrors is null", () => {
    const result = renderManifestEditor({
      state: makeState({}),
      validator: noopValidator,
      validationErrors: null,
      ...noopHandlers,
    });
    const flat = collectAllStrings(result);
    // The errors panel is gated on the explicit non-null check, not on
    // length, so a future refactor that swaps to `[]` would still pass —
    // we assert the rendered class string is absent.
    expect(flat).not.toContain('class="errors"');
  });
});

describe("DocsManifestEditor — class shape + registration", () => {
  test("class exists and registers reactive state + validator props", () => {
    expect(typeof DocsManifestEditor).toBe("function");
    const props = DocsManifestEditor.elementProperties;
    expect(props.get("state")).toBeDefined();
    expect(props.get("validator")).toBeDefined();
  });

  test("registers as 'docs-manifest-editor' on import", () => {
    if (typeof customElements !== "undefined") {
      expect(customElements.get("docs-manifest-editor")).toBeDefined();
    } else {
      expect(typeof DocsManifestEditor).toBe("function");
    }
  });

  test("static styles exist", () => {
    expect(DocsManifestEditor.styles).toBeDefined();
  });
});

describe("DocsManifestEditor — event dispatch", () => {
  test("apply-click dispatches playground-manifest-apply when validator returns valid", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", {
      value: makeState({}),
      writable: true,
    });
    Object.defineProperty(inst, "validator", {
      value: noopValidator,
      writable: true,
    });
    // The validation-error array is internal `@state` but lives on the
    // prototype as the field-init from the decorator; tests bypass the
    // decorator so we install it manually.
    Object.defineProperty(inst, "_validationErrors", {
      value: null,
      writable: true,
    });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onApply: () => void })._onApply;
    handler.call(inst);
    expect(seen.some((e) => e.type === "playground-manifest-apply")).toBe(true);
  });

  test("apply-click does NOT dispatch when validator returns invalid; surfaces errors instead", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", {
      value: makeState({
        manifestDraft: { ...BASE_DRAFT, name: "" },
      }),
      writable: true,
    });
    const failingValidator: ManifestValidator = () => ({
      valid: false,
      errors: ["$ name minLength: must NOT have fewer than 1 characters"],
    });
    Object.defineProperty(inst, "validator", {
      value: failingValidator,
      writable: true,
    });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onApply: () => void })._onApply;
    handler.call(inst);
    expect(seen.length).toBe(0);
    // Invalid path should write the error list back onto the instance so
    // the next render can show it inline.
    const errors = (inst as unknown as { _validationErrors: string[] | null })._validationErrors;
    expect(errors).not.toBeNull();
    expect(errors?.length ?? 0).toBeGreaterThan(0);
  });

  test("name-input dispatches playground-manifest-edit with name patch", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", { value: makeState({}), writable: true });
    Object.defineProperty(inst, "validator", { value: noopValidator, writable: true });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onNameInput: (e: Event) => void })._onNameInput;
    const fakeEvent = { target: { value: "new-name" } } as unknown as Event;
    handler.call(inst, fakeEvent);
    expect(seen.length).toBe(1);
    expect(seen[0]?.type).toBe("playground-manifest-edit");
    const detail = seen[0]?.detail as { patch: Partial<ManifestDraft> };
    expect(detail.patch).toEqual({ name: "new-name" });
  });

  test("runtime-change dispatches playground-manifest-edit with runtime patch", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", { value: makeState({}), writable: true });
    Object.defineProperty(inst, "validator", { value: noopValidator, writable: true });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onRuntimeChange: (e: Event) => void })._onRuntimeChange;
    const fakeEvent = { target: { value: "mock" } } as unknown as Event;
    handler.call(inst, fakeEvent);
    const detail = seen[0]?.detail as { patch: Partial<ManifestDraft> };
    expect(detail.patch).toEqual({ runtime: "mock" });
  });

  test("permissions-change dispatches playground-manifest-edit with permissions patch", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", { value: makeState({}), writable: true });
    Object.defineProperty(inst, "validator", { value: noopValidator, writable: true });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onPermissionsChange: (e: Event) => void })
      ._onPermissionsChange;
    const fakeEvent = { target: { value: "yolo" } } as unknown as Event;
    handler.call(inst, fakeEvent);
    const detail = seen[0]?.detail as { patch: Partial<ManifestDraft> };
    expect(detail.patch).toEqual({ permissions: "yolo" });
  });

  test("tool-name input dispatches a tools-array patch (single-tool, multi-row deferred)", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", { value: makeState({}), writable: true });
    Object.defineProperty(inst, "validator", { value: noopValidator, writable: true });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onToolNameInput: (e: Event) => void })._onToolNameInput;
    const fakeEvent = { target: { value: "renamedTool" } } as unknown as Event;
    handler.call(inst, fakeEvent);
    const detail = seen[0]?.detail as { patch: Partial<ManifestDraft> };
    expect(detail.patch.tools).toBeDefined();
    expect(detail.patch.tools?.[0]?.name).toBe("renamedTool");
  });

  test("tool-allow checkbox dispatches a tools-array patch flipping the allow flag", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", { value: makeState({}), writable: true });
    Object.defineProperty(inst, "validator", { value: noopValidator, writable: true });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onToolAllowChange: (e: Event) => void })
      ._onToolAllowChange;
    const fakeEvent = { target: { checked: false } } as unknown as Event;
    handler.call(inst, fakeEvent);
    const detail = seen[0]?.detail as { patch: Partial<ManifestDraft> };
    expect(detail.patch.tools).toBeDefined();
    expect(detail.patch.tools?.[0]?.allow).toBe(false);
  });

  test("playground-manifest-apply event is composed + bubbles (escapes shadow DOM)", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", { value: makeState({}), writable: true });
    Object.defineProperty(inst, "validator", { value: noopValidator, writable: true });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onApply: () => void })._onApply;
    handler.call(inst);
    expect(seen[0]?.bubbles).toBe(true);
    expect(seen[0]?.composed).toBe(true);
  });
});

describe("DocsManifestEditor — validator round-trip with createManifestValidator", () => {
  test("Apply succeeds when the production validator passes the current draft", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", { value: makeState({}), writable: true });
    Object.defineProperty(inst, "validator", {
      value: createManifestValidator(),
      writable: true,
    });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onApply: () => void })._onApply;
    handler.call(inst);
    expect(seen.some((e) => e.type === "playground-manifest-apply")).toBe(true);
  });

  test("Apply fails when the production validator rejects the current draft (empty name)", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", {
      value: makeState({
        manifestDraft: { ...BASE_DRAFT, name: "" },
      }),
      writable: true,
    });
    Object.defineProperty(inst, "validator", {
      value: createManifestValidator(),
      writable: true,
    });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (inst as unknown as { _onApply: () => void })._onApply;
    handler.call(inst);
    expect(seen.length).toBe(0);
    const errors = (inst as unknown as { _validationErrors: string[] | null })._validationErrors;
    expect(errors).not.toBeNull();
  });
});

describe("DocsManifestEditor — stale validation errors clear on edit", () => {
  test("a draft edit after a failed Apply clears the stale error banner", () => {
    // User types an empty name, clicks Apply, sees the banner, then types a
    // corrected name; the banner must disappear without waiting for Apply.
    const inst = instance();
    Object.defineProperty(inst, "state", {
      value: makeState({
        manifestDraft: { ...BASE_DRAFT, name: "" },
      }),
      writable: true,
    });
    Object.defineProperty(inst, "validator", {
      value: createManifestValidator(),
      writable: true,
    });
    Object.defineProperty(inst, "_validationErrors", { value: null, writable: true });
    inst.dispatchEvent = (): boolean => true;

    // First: simulate a failed Apply that populates _validationErrors.
    const apply = (inst as unknown as { _onApply: () => void })._onApply;
    apply.call(inst);
    const errorsAfterApply = (inst as unknown as { _validationErrors: string[] | null })
      ._validationErrors;
    expect(errorsAfterApply).not.toBeNull();
    expect(errorsAfterApply?.length ?? 0).toBeGreaterThan(0);

    // Then: simulate the user editing the name field. The dirty-feedback
    // contract requires the banner to clear on the next draft edit, NOT on
    // the next Apply.
    const onPatch = (inst as unknown as { _onPatch: (p: Partial<ManifestDraft>) => void })._onPatch;
    onPatch.call(inst, { name: "fixed" });
    const errorsAfterEdit = (inst as unknown as { _validationErrors: string[] | null })
      ._validationErrors;
    expect(errorsAfterEdit).toBeNull();
  });

  test("editing through any field handler (name/runtime/permissions/tool) clears errors", () => {
    // Every field-input handler funnels through `_onPatch`, so the
    // dirty-clear behavior is uniform. This test pins that contract — if
    // a future refactor adds a handler that bypasses `_onPatch`, this
    // fires before users notice the regression.
    const handlerNames: ReadonlyArray<keyof typeof fakeEvents> = [
      "_onNameInput",
      "_onRuntimeChange",
      "_onPermissionsChange",
      "_onToolNameInput",
      "_onToolAllowChange",
    ];
    const fakeEvents = {
      _onNameInput: { target: { value: "x" } } as unknown as Event,
      _onRuntimeChange: { target: { value: "mock" } } as unknown as Event,
      _onPermissionsChange: { target: { value: "yolo" } } as unknown as Event,
      _onToolNameInput: { target: { value: "x" } } as unknown as Event,
      _onToolAllowChange: { target: { checked: false } } as unknown as Event,
    };

    for (const handlerName of handlerNames) {
      const inst = instance();
      Object.defineProperty(inst, "state", { value: makeState({}), writable: true });
      Object.defineProperty(inst, "validator", { value: noopValidator, writable: true });
      // Pre-populate stale errors as if a prior Apply had failed.
      Object.defineProperty(inst, "_validationErrors", {
        value: ["$ stale: prior error"],
        writable: true,
      });
      inst.dispatchEvent = (): boolean => true;

      const handler = (inst as unknown as Record<string, (e: Event) => void>)[handlerName];
      handler.call(inst, fakeEvents[handlerName]);

      const errors = (inst as unknown as { _validationErrors: string[] | null })._validationErrors;
      expect(errors, `${handlerName} should clear stale validation errors`).toBeNull();
    }
  });
});
