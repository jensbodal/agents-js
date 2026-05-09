import { beforeEach, describe, expect, mock, test } from "bun:test";
import "lit"; // Ensures the lit customElements polyfill is installed in the bun test env.
import { safeCustomElement } from "../src/safe-custom-element.ts";

// Unique counter so each test gets a fresh tag name even though the registry
// is a module-level singleton that persists across tests.
let _seq = 0;
function nextTag(): string {
  _seq += 1;
  return `acp-safe-test-${_seq}`;
}

// Fabricate placeholder constructors. We are asserting on registry bookkeeping
// only (not runtime element construction), so the Lit polyfill accepts any
// constructor here — it does not enforce HTMLElement inheritance. The cast
// matches the `CustomElementConstructor` shape the decorator expects.
const makeClass = (): CustomElementConstructor =>
  class {
    // biome-ignore lint/suspicious/noExplicitAny: polyfill accepts bare constructors for this bookkeeping check
  } as any;

describe("safeCustomElement", () => {
  test("registers an element on first decoration (TC39 decorator path)", () => {
    const tag = nextTag();
    const Elem = makeClass();
    // Simulate TC39 class decorator context — the real runtime supplies an
    // object with addInitializer. We invoke the initializer synchronously
    // to mirror Lit's behavior.
    const initializers: Array<() => void> = [];
    const ctx = { addInitializer: (fn: () => void) => initializers.push(fn) };
    safeCustomElement(tag)(Elem, ctx);
    for (const fn of initializers) fn();
    expect(customElements.get(tag)).toBe(Elem);
  });

  test("registers an element on first decoration (legacy decorator path)", () => {
    const tag = nextTag();
    const Elem = makeClass();
    safeCustomElement(tag)(Elem);
    expect(customElements.get(tag)).toBe(Elem);
  });

  test("does not throw when the same class re-registers (HMR re-execution)", () => {
    const tag = nextTag();
    const Elem = makeClass();
    safeCustomElement(tag)(Elem);
    // Re-running the decorator with the SAME class is the common HMR case
    // for a module that gets re-evaluated without source changes.
    expect(() => safeCustomElement(tag)(Elem)).not.toThrow();
    expect(customElements.get(tag)).toBe(Elem);
  });

  test("does not throw when a different class tries to register the same tag", () => {
    const tag = nextTag();
    const ElemA = makeClass();
    const ElemB = makeClass();
    safeCustomElement(tag)(ElemA);
    expect(() => safeCustomElement(tag)(ElemB)).not.toThrow();
    // First registration wins — existing DOM nodes depend on it.
    expect(customElements.get(tag)).toBe(ElemA);
  });

  test("warns once when a different class tries to register the same tag", () => {
    const tag = nextTag();
    const ElemA = makeClass();
    const ElemB = makeClass();
    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy;
    try {
      safeCustomElement(tag)(ElemA);
      safeCustomElement(tag)(ElemB);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg] = warnSpy.mock.calls[0] ?? [];
    expect(String(msg)).toContain(tag);
    expect(String(msg)).toContain("safeCustomElement");
  });

  test("does not warn when the same class re-registers", () => {
    const tag = nextTag();
    const Elem = makeClass();
    const originalWarn = console.warn;
    const warnSpy = mock(() => {});
    console.warn = warnSpy;
    try {
      safeCustomElement(tag)(Elem);
      safeCustomElement(tag)(Elem);
      safeCustomElement(tag)(Elem);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("ui-components HMR re-registration regression", () => {
  // The real symptom the plugin hit: an `acp-*` element module gets
  // re-executed (Obsidian plugin soft-reload, Vite HMR, etc.) and the
  // decorator tries to register the tag a second time. Before the fix this
  // threw `NotSupportedError`; after the fix it is a no-op.
  //
  // We drive this via `AcpAuthSelector` specifically because that is the
  // element the user observed crashing in production.

  beforeEach(async () => {
    // Ensure the element module is loaded so the tag is registered.
    await import("../src/acp-auth-selector.ts");
  });

  test("acp-auth-selector is registered after module import", () => {
    expect(customElements.get("acp-auth-selector")).toBeDefined();
  });

  test("re-running the decorator with a re-executed class does not throw", () => {
    // Simulate module re-execution: a NEW class constructor for the same tag.
    // This is what Obsidian's plugin soft-reload produces — the old class is
    // still in the registry, the new module evaluation creates a fresh class
    // and the decorator runs against it.
    const ReExecutedAcpAuthSelector = makeClass();
    expect(() => {
      safeCustomElement("acp-auth-selector")(ReExecutedAcpAuthSelector);
    }).not.toThrow();
    // Original registration is preserved.
    const registered = customElements.get("acp-auth-selector");
    expect(registered).toBeDefined();
    expect(registered).not.toBe(ReExecutedAcpAuthSelector);
  });
});
