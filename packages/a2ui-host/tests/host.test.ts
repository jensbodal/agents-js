/**
 * Unit tests for `@agents-js/a2ui-host`.
 *
 * Merged from the two near-verbatim copies that previously lived in
 * `apps/web-ui/src/a2ui-host.test.ts` and
 * `.worktrees/obsidian-acp-plugin/test/ui/a2ui-host.test.ts`.
 *
 * Strategy: bypass Lit's `render()` via `renderToMount` / `clearMount`
 * overrides so the suite runs without a real DOM (Bun's test runner has
 * no DOM, and pulling in `happy-dom` / `jsdom` for these tests would be
 * overkill — the host's render scheduling and template factory are
 * directly observable through the counter + `buildTemplate`).
 */
import { describe, expect, test } from "bun:test";
import type { A2uiMessage } from "@agents-js/a2ui-types";
import type { TemplateResult } from "lit";
import { createBridgeSurfaceAdapter } from "../src/acp-host/index.ts";
import { A2uiBridge, type SurfaceEventSink } from "../src/bridge.ts";
import { A2uiHost, type A2uiHostEventHandler, type SurfaceRenderer } from "../src/host.ts";

const ACP_CATALOG_ID = "https://agents-js.bodal.dev/catalog/acp/0.1";
const BASIC_CATALOG_ID = "https://a2ui.org/catalog/basic/0.9";

/**
 * Noop sink for tests that don't care about outbound events — just satisfies
 * the required {@link A2uiBridgeOptions.sink} field.
 */
const noopSink: SurfaceEventSink = {
  sendSurfaceEvent: () => {},
};

/**
 * Stub renderer that reads the current surface group and emits a flat
 * per-component summary string wrapped in a `TemplateResult`-shaped
 * object. Enough to prove `buildTemplate` integrates with the processor's
 * model without depending on `@agents-js/a2ui-renderer` (which brings
 * Lit + every ACP primitive along with it).
 */
const stubRenderer: SurfaceRenderer = (model, opts) => {
  void opts;
  const lines: string[] = [];
  for (const surface of model.surfacesMap.values()) {
    lines.push(`surface:${surface.id}`);
    for (const [, component] of surface.componentsModel.entries) {
      lines.push(`component:${component.type}:${component.id}`);
    }
  }
  return {
    _$litType$: 1,
    strings: [lines.join("\n")],
    values: [],
  } as unknown as TemplateResult;
};

/**
 * Build an A2uiHost whose render step is swapped for a counter. Bypasses
 * Lit's `render()` entirely so the suite runs without a DOM.
 */
function makeHost(opts: {
  onEvent?: A2uiHostEventHandler;
  onInvalidMessage?: (e: Error, raw: unknown) => void;
  renderer?: SurfaceRenderer;
}): {
  host: A2uiHost;
  renderCount: () => number;
} {
  let renderCount = 0;
  const mount = {} as unknown as HTMLElement;
  const host = new A2uiHost(mount, {
    renderer: opts.renderer ?? stubRenderer,
    onEvent: opts.onEvent ?? (() => {}),
    onInvalidMessage: opts.onInvalidMessage,
  });
  const hostRecord = host as unknown as {
    renderToMount: () => void;
    clearMount: () => void;
  };
  hostRecord.renderToMount = () => {
    renderCount += 1;
  };
  hostRecord.clearMount = () => {};
  return { host, renderCount: () => renderCount };
}

/** Flushes queued microtasks so coalesced renders settle before assertions. */
const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("A2uiHost.applyMessage", () => {
  test("valid CreateSurface populates the surface model and triggers a render", async () => {
    const { host, renderCount } = makeHost({});
    host.applyMessage({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    expect(host.getModelForTesting().surfacesMap.has("s1")).toBe(true);
    await flushMicrotasks();
    expect(renderCount()).toBe(1);
  });

  test("invalid message is routed to onInvalidMessage and does not render", async () => {
    const caught: Error[] = [];
    const { host, renderCount } = makeHost({
      onInvalidMessage: (err) => {
        caught.push(err);
      },
    });
    host.applyMessage({ version: "v0.1", createSurface: { surfaceId: "s1" } });
    expect(caught).toHaveLength(1);
    await flushMicrotasks();
    expect(renderCount()).toBe(0);
    expect(host.getModelForTesting().surfacesMap.size).toBe(0);
  });

  test("destroyed host drops subsequent messages", async () => {
    const caught: Error[] = [];
    const { host, renderCount } = makeHost({
      onInvalidMessage: (err) => {
        caught.push(err);
      },
    });
    host.destroy();
    expect(host.isDestroyed).toBe(true);
    host.applyMessage({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    await flushMicrotasks();
    expect(renderCount()).toBe(0);
    expect(caught).toHaveLength(0);
  });

  test("destroy is idempotent", () => {
    const { host } = makeHost({});
    host.destroy();
    host.destroy();
    expect(host.isDestroyed).toBe(true);
  });

  test("a burst of messages within one tick coalesces into a single render", async () => {
    const { host, renderCount } = makeHost({});
    host.applyMessage({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    host.applyMessage({
      version: "v0.9",
      updateDataModel: { surfaceId: "s1", path: "/foo", value: 1 },
    });
    host.applyMessage({
      version: "v0.9",
      updateDataModel: { surfaceId: "s1", path: "/foo", value: 2 },
    });
    await flushMicrotasks();
    expect(renderCount()).toBe(1);
  });

  test("DeleteSurface removes the surface from the model", () => {
    const { host } = makeHost({});
    host.applyMessage({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    expect(host.getModelForTesting().surfacesMap.size).toBe(1);
    host.applyMessage({
      version: "v0.9",
      deleteSurface: { surfaceId: "s1" },
    });
    expect(host.getModelForTesting().surfacesMap.size).toBe(0);
  });
});

describe("A2uiHost.buildTemplate", () => {
  test("renders an AcpChatApp tree through the stub renderer", () => {
    const { host } = makeHost({});
    host.applyMessage({
      version: "v0.9",
      createSurface: { surfaceId: "demo-chat", catalogId: ACP_CATALOG_ID },
    });
    host.applyMessage({
      version: "v0.9",
      updateComponents: {
        surfaceId: "demo-chat",
        components: [
          { component: "AcpChatApp", id: "root", transcript: "tr", promptInput: "pi" },
          { component: "AcpTranscript", id: "tr", children: ["m1"] },
          { component: "AcpMessage", id: "m1", role: "agent", body: "Hello from the host." },
          {
            component: "AcpPromptInput",
            id: "pi",
            value: { path: "/input" },
            placeholder: "Type a reply...",
            submit: "send",
          },
        ],
      },
    });

    const template = host.buildTemplate();
    const rendered = (template as unknown as { strings: string[] }).strings[0] ?? "";
    expect(rendered).toContain("surface:demo-chat");
    expect(rendered).toContain("component:AcpChatApp:root");
    expect(rendered).toContain("component:AcpTranscript:tr");
    expect(rendered).toContain("component:AcpMessage:m1");
    expect(rendered).toContain("component:AcpPromptInput:pi");
  });
});

describe("A2uiBridge", () => {
  test("forwards host events to the sink", () => {
    const events: Array<{ surfaceId: string; actionName: string; payload: unknown }> = [];
    const sink: SurfaceEventSink = {
      sendSurfaceEvent(surfaceId, actionName, payload) {
        events.push({ surfaceId, actionName, payload });
      },
    };
    const { host } = makeHost({});
    const bridge = new A2uiBridge({ sink });
    bridge.attachHost(host);

    bridge.onEvent("s1", "send", { text: "hi" });
    expect(events).toEqual([{ surfaceId: "s1", actionName: "send", payload: { text: "hi" } }]);
  });

  // removed: sink now required at construction — the "no sink bound" warn
  // path no longer exists as a runtime concern.

  test("applyInbound reaches the host's applyMessage", () => {
    const { host } = makeHost({});
    const bridge = new A2uiBridge({ sink: noopSink });
    bridge.attachHost(host);

    bridge.applyInbound({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    expect(host.getModelForTesting().surfacesMap.has("s1")).toBe(true);
  });

  test("applyInbound is a no-op with no host attached", () => {
    const bridge = new A2uiBridge({ sink: noopSink });
    // Should not throw.
    bridge.applyInbound({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    expect(bridge.getHost()).toBeNull();
  });

  test("applyInbound drops messages after the host is destroyed", () => {
    const { host, renderCount } = makeHost({});
    const bridge = new A2uiBridge({ sink: noopSink });
    bridge.attachHost(host);
    host.destroy();
    bridge.applyInbound({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    expect(host.getModelForTesting().surfacesMap.size).toBe(0);
    // Render would only have fired if applyMessage actually ran.
    expect(renderCount()).toBe(0);
  });

  test("onInboundDrop fires with reason 'no-host' when applyInbound called before attachHost", () => {
    const drops: Array<{ reason: "no-host" | "host-destroyed"; message: A2uiMessage }> = [];
    const bridge = new A2uiBridge({
      sink: noopSink,
      onInboundDrop: (reason, message) => {
        drops.push({ reason, message });
      },
    });
    const msg: A2uiMessage = {
      version: "v0.9",
      createSurface: { surfaceId: "s-drop", catalogId: BASIC_CATALOG_ID },
    };
    bridge.applyInbound(msg);
    expect(drops).toEqual([{ reason: "no-host", message: msg }]);
  });

  test("onInboundDrop fires with reason 'host-destroyed' when applyInbound called on a destroyed host", () => {
    const drops: Array<{ reason: "no-host" | "host-destroyed"; message: A2uiMessage }> = [];
    const { host } = makeHost({});
    const bridge = new A2uiBridge({
      sink: noopSink,
      onInboundDrop: (reason, message) => {
        drops.push({ reason, message });
      },
    });
    bridge.attachHost(host);
    host.destroy();
    const msg: A2uiMessage = {
      version: "v0.9",
      createSurface: { surfaceId: "s-zombie", catalogId: BASIC_CATALOG_ID },
    };
    bridge.applyInbound(msg);
    expect(drops).toEqual([{ reason: "host-destroyed", message: msg }]);
  });

  test("attachHost returns the previous host and swaps the inbound target", () => {
    const { host: hostA } = makeHost({});
    const { host: hostB } = makeHost({});
    const bridge = new A2uiBridge({ sink: noopSink });
    expect(bridge.attachHost(hostA)).toBeNull();
    expect(bridge.getHost()).toBe(hostA);
    expect(bridge.attachHost(hostB)).toBe(hostA);
    expect(bridge.getHost()).toBe(hostB);

    bridge.applyInbound({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    expect(hostA.getModelForTesting().surfacesMap.size).toBe(0);
    expect(hostB.getModelForTesting().surfacesMap.has("s1")).toBe(true);
  });

  test("detachHost clears the slot when the caller owns it", () => {
    const { host } = makeHost({});
    const bridge = new A2uiBridge({ sink: noopSink });
    bridge.attachHost(host);

    expect(bridge.detachHost(host)).toBe(true);
    expect(bridge.getHost()).toBeNull();

    bridge.applyInbound({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    expect(host.getModelForTesting().surfacesMap.size).toBe(0);
  });

  test("isHostAttached reflects attach/detach transitions", () => {
    const { host } = makeHost({});
    const bridge = new A2uiBridge({ sink: noopSink });
    expect(bridge.isHostAttached()).toBe(false);
    bridge.attachHost(host);
    expect(bridge.isHostAttached()).toBe(true);
    expect(bridge.detachHost(host)).toBe(true);
    expect(bridge.isHostAttached()).toBe(false);
  });

  test("attachHost throws when the host is already destroyed", () => {
    const { host } = makeHost({});
    host.destroy();
    const bridge = new A2uiBridge({ sink: noopSink });
    expect(() => bridge.attachHost(host)).toThrow(/cannot attach a destroyed host/);
    // Slot must remain empty — the throw happens before the swap.
    expect(bridge.getHost()).toBeNull();
  });

  test("isHostLive is false when no host is attached", () => {
    const bridge = new A2uiBridge({ sink: noopSink });
    expect(bridge.isHostLive()).toBe(false);
  });

  test("isHostLive is true for a fresh attached host", () => {
    const { host } = makeHost({});
    const bridge = new A2uiBridge({ sink: noopSink });
    bridge.attachHost(host);
    expect(bridge.isHostLive()).toBe(true);
  });

  test("isHostLive is false once the attached host is destroyed (zombie slot)", () => {
    const { host } = makeHost({});
    const bridge = new A2uiBridge({ sink: noopSink });
    bridge.attachHost(host);
    host.destroy();
    // `isHostAttached` stays true (slot still bound), but `isHostLive`
    // reports the zombie.
    expect(bridge.isHostAttached()).toBe(true);
    expect(bridge.isHostLive()).toBe(false);
  });

  test("createHost returns a host wired to the bridge's onEvent forwarder", () => {
    const events: Array<{ surfaceId: string; actionName: string; payload: unknown }> = [];
    const sink: SurfaceEventSink = {
      sendSurfaceEvent(surfaceId, actionName, payload) {
        events.push({ surfaceId, actionName, payload });
      },
    };
    const bridge = new A2uiBridge({ sink });

    // Renderer captures the `onEvent` handed to it so the test can assert
    // createHost actually threaded the bridge's forwarder into the host.
    const captured: { handler: A2uiHostEventHandler | null } = { handler: null };
    const captureRenderer: SurfaceRenderer = (model, opts) => {
      captured.handler = opts.onEvent;
      return stubRenderer(model, opts);
    };
    const mount = {} as unknown as HTMLElement;
    const host = bridge.createHost(mount, { renderer: captureRenderer });
    // Bypass real Lit render so the suite stays DOM-free.
    const hostRecord = host as unknown as {
      renderToMount: () => void;
      clearMount: () => void;
    };
    hostRecord.renderToMount = () => {};
    hostRecord.clearMount = () => {};

    // Invoke buildTemplate to trigger the renderer and capture `onEvent`.
    host.buildTemplate();
    const handler = captured.handler;
    if (handler === null) throw new Error("renderer did not receive onEvent");

    handler("s1", "tap", { ok: true });
    expect(events).toEqual([{ surfaceId: "s1", actionName: "tap", payload: { ok: true } }]);
    // And prove it is actually the bridge's forwarder, not just any
    // function — reference equality against `bridge.onEvent`.
    expect(handler).toBe(bridge.onEvent);
  });

  test("detachHost is a no-op when a different host owns the slot (revival race)", () => {
    const { host: stale } = makeHost({});
    const { host: fresh } = makeHost({});
    const bridge = new A2uiBridge({ sink: noopSink });
    bridge.attachHost(fresh);

    // Simulate a retiring view whose reference was displaced by a
    // freshly-mounted revival before it got to detach.
    expect(bridge.detachHost(stale)).toBe(false);
    expect(bridge.getHost()).toBe(fresh);

    // The fresh host is still live and receiving.
    bridge.applyInbound({
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: BASIC_CATALOG_ID },
    });
    expect(fresh.getModelForTesting().surfacesMap.has("s1")).toBe(true);
    expect(stale.getModelForTesting().surfacesMap.size).toBe(0);
  });

  test("setSink swaps the outbound target at runtime", () => {
    const sinkA: SurfaceEventSink = {
      sendSurfaceEvent: () => {
        throw new Error("should not be called after setSink");
      },
    };
    const received: Array<{ surfaceId: string; actionName: string }> = [];
    const sinkB: SurfaceEventSink = {
      sendSurfaceEvent: (surfaceId, actionName) => {
        received.push({ surfaceId, actionName });
      },
    };
    const { host } = makeHost({});
    const bridge = new A2uiBridge({ sink: sinkA });
    bridge.attachHost(host);
    bridge.setSink(sinkB);
    bridge.onEvent("s2", "tap", {});
    expect(received).toEqual([{ surfaceId: "s2", actionName: "tap" }]);
  });
});

describe("createBridgeSurfaceAdapter", () => {
  test("forwards handleSurfaceMessage to bridge.applyInbound", () => {
    const { host } = makeHost({});
    const bridge = new A2uiBridge({ sink: noopSink });
    bridge.attachHost(host);
    const adapter = createBridgeSurfaceAdapter(bridge);

    adapter.handleSurfaceMessage({
      version: "v0.9",
      createSurface: { surfaceId: "via-adapter", catalogId: BASIC_CATALOG_ID },
    });
    expect(host.getModelForTesting().surfacesMap.has("via-adapter")).toBe(true);
  });

  test("adapter does not throw when bridge has no host", () => {
    const bridge = new A2uiBridge({ sink: noopSink });
    const adapter = createBridgeSurfaceAdapter(bridge);

    // Should not throw.
    adapter.handleSurfaceMessage({
      version: "v0.9",
      createSurface: { surfaceId: "no-host", catalogId: BASIC_CATALOG_ID },
    });
  });

  test("adapter exposes handleSurfaceClosed as an explicit no-op", () => {
    const bridge = new A2uiBridge({ sink: noopSink });
    const adapter = createBridgeSurfaceAdapter(bridge);
    // Should not throw and should be present even though MessageProcessor
    // already handles DeleteSurface natively. Grep-hit for future
    // maintainers who want to add per-surface cleanup.
    expect(adapter.handleSurfaceClosed).toBeDefined();
    adapter.handleSurfaceClosed?.("any-surface-id");
  });
});
