/**
 * HMR regression test for `@agents-js/a2ui-host`.
 *
 * Pins the invariant that protects against the class of bug fixed in
 * `c45149b` ("fix(ui-components): make custom-element registration
 * HMR-safe"): double-import of the package — directly, or transitively
 * via the renderer — must not throw `NotSupportedError` from
 * `customElements.define` and must not double-construct any
 * module-level singletons.
 *
 * The package itself has no module-level state; the risk lives in the
 * transitive `@agents-js/ui-components` imports that fire
 * `safeCustomElement` decorators at module-init time. This test exercises
 * both: it imports the package via two cache-busted paths and instantiates
 * a host from each, then independently triggers a transitive
 * ui-components import to confirm `safeCustomElement` keeps the
 * registration idempotent across re-imports.
 */
import { describe, expect, test } from "bun:test";
import type { TemplateResult } from "lit";
import { A2uiBridge, A2uiHost, type SurfaceRenderer } from "../src/index.ts";

const BASIC_CATALOG_ID = "https://a2ui.org/catalog/basic/0.9";

const stubRenderer: SurfaceRenderer = (model) => {
  let line = "";
  for (const surface of model.surfacesMap.values()) {
    line += `surface:${surface.id};`;
  }
  return {
    _$litType$: 1,
    strings: [line],
    values: [],
  } as unknown as TemplateResult;
};

function makeMount(): HTMLElement {
  return {} as unknown as HTMLElement;
}

/**
 * Build a host with `renderToMount` / `clearMount` stubbed to no-ops so the
 * suite can run under Bun without a DOM. The constructor is the public
 * surface we want to exercise here; Lit's `render()` is exercised in the
 * web-ui live smoke and in `packages/a2ui-renderer` unit tests.
 *
 * Accepts a host class because the regression suite imports the package
 * via cache-busted paths and gets distinct class identities back.
 */
function makeHost(HostCtor: typeof A2uiHost): A2uiHost {
  const host = new HostCtor(makeMount(), {
    renderer: stubRenderer,
    onEvent: () => {},
  });
  const hostRecord = host as unknown as {
    renderToMount: () => void;
    clearMount: () => void;
  };
  hostRecord.renderToMount = () => {};
  hostRecord.clearMount = () => {};
  return host;
}

describe("@agents-js/a2ui-host HMR regression", () => {
  test("re-importing the package via a cache-busted path does not throw", async () => {
    // Bun's loader keys modules by resolved path + query, so a query string
    // forces a second module evaluation. If any module-level singleton
    // initialization snuck into the package, the second evaluation would
    // either throw (e.g. duplicate customElement registration) or be
    // observable through a runtime check.
    const first = await import("../src/index.ts");
    // @ts-expect-error TS2307 — query suffix forces a second module evaluation
    // under bun's loader; tsgo cannot statically resolve it but the runtime
    // import succeeds.
    const second = await import("../src/index.ts?hmr-regression=v2");
    expect(first.A2uiHost).toBeDefined();
    expect(second.A2uiHost).toBeDefined();

    // Distinct module evaluations produce distinct class identities.
    // That distinctness is *expected* under HMR; the host's hot-reload
    // safety does not depend on class identity — it depends on the
    // attach/detach contract treating both classes as equivalent
    // structurally. So both classes must instantiate cleanly side by side.
    const hostA = makeHost(first.A2uiHost);
    const hostB = makeHost(second.A2uiHost);
    expect(hostA.getModelForTesting().surfacesMap.size).toBe(0);
    expect(hostB.getModelForTesting().surfacesMap.size).toBe(0);
    hostA.destroy();
    hostB.destroy();
  });

  test("transitive ui-components import is HMR-safe across re-imports", async () => {
    // Pulling in any acp-* primitive from `@agents-js/ui-components` runs
    // `safeCustomElement` at module init. Re-importing the same module
    // (or a sibling that re-exports the same primitive) must not throw —
    // the safeCustomElement guard from c45149b is what makes this true.
    // If a future refactor swaps the guard back to Lit's stock
    // `@customElement` we need this test to fail loudly.
    const first = await import("@agents-js/ui-components");
    // @ts-expect-error TS2307 — query suffix forces a fresh module evaluation
    // so the safeCustomElement decorators run twice; if the guard is removed
    // the second evaluation throws and this test fails loudly.
    const second = await import("@agents-js/ui-components?hmr-regression=v2");
    expect(first.AcpChatApp).toBeDefined();
    expect(second.AcpChatApp).toBeDefined();
    // No `NotSupportedError` thrown above is the actual assertion.
  });

  test("constructing many hosts in a row never trips the processor singleton trap", () => {
    // The package has no module-level singletons by design, but a casual
    // refactor could introduce one (e.g. memoizing the default catalog
    // list at module scope and mutating it). Pin the invariant: each
    // host gets an independent processor + model.
    const hosts: A2uiHost[] = [];
    for (let i = 0; i < 5; i++) {
      const host = makeHost(A2uiHost);
      host.applyMessage({
        version: "v0.9",
        createSurface: { surfaceId: `s${i}`, catalogId: BASIC_CATALOG_ID },
      });
      hosts.push(host);
    }
    // Each host's model contains exactly its own surface — proves no
    // shared SurfaceGroupModel sneaked in.
    for (let i = 0; i < hosts.length; i++) {
      const host = hosts[i];
      if (!host) throw new Error("expected host");
      expect(host.getModelForTesting().surfacesMap.size).toBe(1);
      expect(host.getModelForTesting().surfacesMap.has(`s${i}`)).toBe(true);
    }
    for (const host of hosts) host.destroy();
  });

  test("bridge state is per-instance — not shared across re-imports", async () => {
    const first = await import("../src/index.ts");
    // @ts-expect-error TS2307 — see above, query suffix forces re-evaluation.
    const second = await import("../src/index.ts?hmr-regression=v3");

    const noopSink = { sendSurfaceEvent: () => {} };
    const bridgeA = new first.A2uiBridge({ sink: noopSink });
    const bridgeB = new second.A2uiBridge({ sink: noopSink });

    const hostA = makeHost(first.A2uiHost);
    const hostB = makeHost(second.A2uiHost);

    bridgeA.attachHost(hostA);
    bridgeB.attachHost(hostB);

    // Each bridge holds only its own host; the second attach must not
    // displace the first across module boundaries.
    expect(bridgeA.getHost()).toBe(hostA);
    expect(bridgeB.getHost()).toBe(hostB);

    hostA.destroy();
    hostB.destroy();
  });

  test("export shape is identical across re-imports", async () => {
    const first = await import("../src/index.ts");
    // @ts-expect-error TS2307 — see above, query suffix forces re-evaluation.
    const second = await import("../src/index.ts?hmr-regression=v4");
    // Match by sorted key list — class identities will differ across
    // evaluations but the public surface must not.
    const firstKeys = Object.keys(first).sort();
    const secondKeys = Object.keys(second).sort();
    expect(secondKeys).toEqual(firstKeys);
    // Spot-check the locked surface from the contract.
    expect(firstKeys).toContain("A2uiHost");
    expect(firstKeys).toContain("A2uiBridge");
    expect(firstKeys).not.toContain("createBridgeSurfaceAdapter");
    // Static import is also exercised so a bad export rename surfaces here
    // even before the dynamic-import comparison runs.
    expect(A2uiBridge).toBeDefined();
  });
});
