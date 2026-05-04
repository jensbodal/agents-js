/**
 * Element-level tests for `<docs-run-controls>`.
 *
 * Strategy mirrors `packages/a2ui-host/tests/host.test.ts` and
 * `packages/ui-components/tests/acp-modal.test.ts`: Bun's test runner has no
 * DOM, so we exercise class structure + event dispatch via prototype-only
 * instances and exercise the render branching against the pure
 * `renderRunControls` helper. Lit's `@property` accessor decorators store
 * their state in private fields that require constructor-time init, which
 * `Object.create()` skips — keeping the render logic in a free function
 * sidesteps the "Cannot read from private field" trap and yields a
 * deterministic test surface.
 *
 * M4 simplification: the mode picker has been retired. These tests only
 * cover the activate-button + status-text surface that remains.
 */
import { describe, expect, test } from "bun:test";
import { DocsRunControls, type RunControlsPhase, renderRunControls } from "./docs-run-controls.ts";

function instance(): DocsRunControls {
  return Object.create(DocsRunControls.prototype) as DocsRunControls;
}

const noop = (): void => {};

describe("DocsRunControls — class shape", () => {
  test("class exists and is a function", () => {
    expect(typeof DocsRunControls).toBe("function");
  });

  test("has reactive properties for phase, loadProgressText, errorText", () => {
    const props = DocsRunControls.elementProperties;
    expect(props.get("phase")).toBeDefined();
    expect(props.get("loadProgressText")).toBeDefined();
    expect(props.get("errorText")).toBeDefined();
  });

  test("does NOT expose mode or modelAvailable props (M4 mode-picker retirement)", () => {
    const props = DocsRunControls.elementProperties;
    expect(props.get("mode")).toBeUndefined();
    expect(props.get("modelAvailable")).toBeUndefined();
  });

  test("static styles exist", () => {
    expect(DocsRunControls.styles).toBeDefined();
  });
});

describe("DocsRunControls — event dispatch", () => {
  test("activate-click dispatches playground-activate with no detail payload", () => {
    const inst = instance();
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (
      inst as unknown as {
        _onActivate: () => void;
      }
    )._onActivate;
    handler.call(inst);
    expect(seen.length).toBe(1);
    expect(seen[0]?.type).toBe("playground-activate");
    // M4: no `mode` payload — the shell reads `state.manifest.runtime`.
    // `CustomEvent` with no `detail` initializer defaults to `null`.
    expect(seen[0]?.detail).toBeNull();
  });

  test("playground-activate event is composed + bubbles (escapes shadow DOM)", () => {
    const inst = instance();
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    (inst as unknown as { _onActivate: () => void })._onActivate.call(inst);
    expect(seen[0]?.bubbles).toBe(true);
    expect(seen[0]?.composed).toBe(true);
  });
});

describe("renderRunControls — branching", () => {
  test("renders detection placeholder when phase === detecting", () => {
    const result = renderRunControls({
      phase: "detecting",
      loadProgressText: "",
      errorText: "",
      onActivate: noop,
    });
    expect(result.strings.join("")).toContain("Checking your browser");
  });

  test("renders progress text when phase === loading", () => {
    const result = renderRunControls({
      phase: "loading",
      loadProgressText: "downloading weights 50%",
      errorText: "",
      onActivate: noop,
    });
    expect(result.strings.join("")).toContain("Loading");
    expect(result.values).toContain("downloading weights 50%");
  });

  test("renders ready notice when phase === active", () => {
    const result = renderRunControls({
      phase: "active",
      loadProgressText: "",
      errorText: "",
      onActivate: noop,
    });
    expect(result.strings.join("")).toContain("Ready");
  });

  test("renders the activate button for ready-to-activate and error phases", () => {
    for (const phase of ["ready-to-activate", "error"] as RunControlsPhase[]) {
      const result = renderRunControls({
        phase,
        loadProgressText: "",
        errorText: "",
        onActivate: noop,
      });
      expect(result.strings.join("")).toContain("Activate");
      expect(result.strings.join("")).toContain("runs locally in your browser");
    }
  });

  test("renders errorText when present in error phase", () => {
    const result = renderRunControls({
      phase: "error",
      loadProgressText: "",
      errorText: "model load failed: network",
      onActivate: noop,
    });
    // The error text lands inside a nested `<p class="error">` template, so
    // we recursively flatten the template values to find it.
    const allValues = flattenTemplateValues(result.values);
    expect(allValues).toContain("model load failed: network");
  });

  test("does NOT render an error <p> when errorText is empty", () => {
    const result = renderRunControls({
      phase: "error",
      loadProgressText: "",
      errorText: "",
      onActivate: noop,
    });
    // No nested template should mention the "error" CSS class string.
    const nested = result.values.filter(
      (v): v is { strings: readonly string[] } =>
        typeof v === "object" && v !== null && "strings" in v,
    );
    for (const t of nested) {
      expect(t.strings.join("")).not.toContain('class="error"');
    }
  });
});

describe("renderRunControls — replay branching (M5)", () => {
  test("active phase: replay button hidden when canReplay=false", () => {
    const result = renderRunControls({
      phase: "active",
      loadProgressText: "",
      errorText: "",
      onActivate: noop,
      canReplay: false,
      isReplaying: false,
      onReplay: noop,
      onStopReplay: noop,
    });
    const flat = collectAllStrings(result);
    expect(flat).not.toContain("Replay last run");
    expect(flat).not.toContain("Stop replay");
  });

  test("active phase: 'Replay last run' button visible when canReplay=true and not replaying", () => {
    const result = renderRunControls({
      phase: "active",
      loadProgressText: "",
      errorText: "",
      onActivate: noop,
      canReplay: true,
      isReplaying: false,
      onReplay: noop,
      onStopReplay: noop,
    });
    const flat = collectAllStrings(result);
    expect(flat).toContain("Replay last run");
    expect(flat).not.toContain("Stop replay");
  });

  test("active phase: 'Stop replay' button visible while isReplaying=true", () => {
    const result = renderRunControls({
      phase: "active",
      loadProgressText: "",
      errorText: "",
      onActivate: noop,
      canReplay: false,
      isReplaying: true,
      onReplay: noop,
      onStopReplay: noop,
    });
    const flat = collectAllStrings(result);
    expect(flat).toContain("Stop replay");
    expect(flat).not.toContain("Replay last run");
  });

  test("ready-to-activate phase: replay button NOT rendered (no past runs)", () => {
    const result = renderRunControls({
      phase: "ready-to-activate",
      loadProgressText: "",
      errorText: "",
      onActivate: noop,
      canReplay: true,
      isReplaying: false,
      onReplay: noop,
      onStopReplay: noop,
    });
    const flat = collectAllStrings(result);
    expect(flat).not.toContain("Replay last run");
    expect(flat).not.toContain("Stop replay");
  });
});

describe("DocsRunControls — replay event dispatch (M5)", () => {
  test("_onReplay dispatches playground-replay (composed + bubbles, no detail)", () => {
    const inst = instance();
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    (inst as unknown as { _onReplay: () => void })._onReplay.call(inst);
    expect(seen.length).toBe(1);
    expect(seen[0]?.type).toBe("playground-replay");
    expect(seen[0]?.bubbles).toBe(true);
    expect(seen[0]?.composed).toBe(true);
    expect(seen[0]?.detail).toBeNull();
  });

  test("_onStopReplay dispatches playground-stop-replay (composed + bubbles, no detail)", () => {
    const inst = instance();
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    (inst as unknown as { _onStopReplay: () => void })._onStopReplay.call(inst);
    expect(seen.length).toBe(1);
    expect(seen[0]?.type).toBe("playground-stop-replay");
    expect(seen[0]?.bubbles).toBe(true);
    expect(seen[0]?.composed).toBe(true);
  });

  test("class exposes canReplay and isReplaying as Boolean reactive properties", () => {
    const props = DocsRunControls.elementProperties;
    expect(props.get("canReplay")).toBeDefined();
    expect(props.get("isReplaying")).toBeDefined();
    expect(props.get("canReplay")?.type).toBe(Boolean);
    expect(props.get("isReplaying")?.type).toBe(Boolean);
  });
});

describe("DocsRunControls — registration", () => {
  test("registers as 'docs-run-controls' on import (custom-elements registry)", () => {
    if (typeof customElements !== "undefined") {
      const Ctor = customElements.get("docs-run-controls");
      expect(Ctor).toBeDefined();
    } else {
      // Environment lacks customElements (some Bun-test variants); the class
      // still imports cleanly which is the only invariant we can check.
      expect(typeof DocsRunControls).toBe("function");
    }
  });
});

/**
 * Recursively flatten a `lit-html` `TemplateResult.values` array, descending
 * into any nested `TemplateResult` objects. Lets a render assertion grab
 * deeply-nested interpolation values (e.g. an error message rendered inside
 * a conditional `<p class="error">${msg}</p>` sub-template).
 */
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

interface MaybeTemplateResult {
  strings?: readonly string[];
  values?: readonly unknown[];
}

/**
 * Recursively walk a `lit-html` `TemplateResult`, concatenating every
 * static `strings` chunk it contains. Mirrors the helper in the shell
 * suite — kept local so this test file stays self-contained.
 */
function collectAllStrings(node: MaybeTemplateResult | unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const t = node as MaybeTemplateResult;
  let out = "";
  if (Array.isArray(t.strings)) out += t.strings.join("");
  if (Array.isArray(t.values)) {
    for (const v of t.values) out += collectAllStrings(v);
  }
  return out;
}
