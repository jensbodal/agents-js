/**
 * Learning test (LT-4): A2UI declarative surfaces, end-to-end.
 *
 * Proves the full host/renderer pipeline against a REAL DOM (happy-dom, see
 * `../happydom.ts` preload) rather than a string-level template slice:
 *
 *   1. A `CreateSurface -> UpdateComponents -> UpdateDataModel` lifecycle fed
 *      through `A2uiHost.applyMessage` renders the surface's components into
 *      the mount as live DOM nodes (querySelectable `acp-*` elements), via
 *      `@agents-js/a2ui-renderer`'s `renderSurface` + Lit's `render()`.
 *
 *   2. A user interaction on a rendered primitive (an `acp-send` CustomEvent
 *      from `acp-prompt-input`, the DOM event the live component emits)
 *      round-trips back through the renderer's action binding -> the host's
 *      `onEvent` -> the `A2uiBridge` -> the host's `sendSurfaceEvent` sink,
 *      arriving with the surface id, the bound action name, and the payload
 *      intact.
 *
 * The render-tree leg reuses the ready-made demo sequences
 * (`buildDemoMessages` / `buildLandingMessages` from `apps/web-ui`) so this
 * test exercises the exact payload shapes the live web-ui demo pushes. Those
 * sequences only render an `AcpMessage` (no interactive component), so the
 * event leg authors an `AcpChatApp` + `AcpPromptInput` surface — `submit`
 * is the action name that surfaces as the round-tripped `actionName`.
 *
 * Companion coverage: `packages/a2ui-renderer/tests/surface-view.test.ts`
 * asserts the template structure DOM-free; `packages/host/tests/
 * a2ui-surface-e2e.test.ts` covers the surface_event relay across the gateway
 * wire. This learning test closes the loop with a real DOM render + a real
 * dispatched DOM event.
 */
import { describe, expect, test } from "bun:test";
import { A2uiBridge, type SurfaceEventSink } from "@agents-js/a2ui-host";
import { renderSurface } from "@agents-js/a2ui-renderer";
import { type A2uiMessage, ACP_CATALOG_ID } from "@agents-js/a2ui-types";
import { buildDemoMessages } from "@agents-js/web-ui/src/a2ui-demo.ts";
import { buildLandingMessages, LANDING_SURFACE_ID } from "@agents-js/web-ui/src/landing-surface.ts";

/** Flush queued microtasks so the host's coalesced render settles. */
const flushRender = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

interface CapturedEvent {
  readonly surfaceId: string;
  readonly actionName: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Stand up a bridge + host wired to a fresh mount in the global (happy-dom)
 * document, with a recording sink. Returns the mount and the recorded events
 * so each test can drive `applyMessage` and inspect both the rendered DOM and
 * the surface-event round-trip.
 */
function mountSurface(): {
  mount: HTMLElement;
  events: CapturedEvent[];
  apply: (messages: readonly A2uiMessage[]) => void;
  destroy: () => void;
} {
  const mount = document.createElement("div");
  document.body.appendChild(mount);

  const events: CapturedEvent[] = [];
  const sink: SurfaceEventSink = {
    sendSurfaceEvent(surfaceId, actionName, payload) {
      events.push({ surfaceId, actionName, payload });
    },
  };

  const bridge = new A2uiBridge({ sink });
  const host = bridge.createHost(mount, { renderer: renderSurface, catalogId: ACP_CATALOG_ID });
  bridge.attachHost(host);

  return {
    mount,
    events,
    apply: (messages) => {
      for (const message of messages) host.applyMessage(message);
    },
    destroy: () => {
      host.destroy();
      mount.remove();
    },
  };
}

describe("A2UI surface renders into a real DOM", () => {
  test("landing surface lifecycle renders an acp-message node", async () => {
    const surface = mountSurface();
    try {
      surface.apply(buildLandingMessages());
      await flushRender();

      const message = surface.mount.querySelector("acp-message");
      expect(message).not.toBeNull();
      // The component is a live DOM node carrying the agent role from the payload.
      expect(message?.getAttribute("role")).toBe("agent");
    } finally {
      surface.destroy();
    }
  });

  test("demo CreateSurface -> UpdateComponents -> UpdateDataModel renders the surface", async () => {
    const surface = mountSurface();
    try {
      const messages = buildDemoMessages();
      // Guard the reused sequence still drives all three lifecycle stages so
      // this test keeps covering the full PROVE clause if the demo evolves.
      // `A2uiMessage` is a discriminated union keyed by which lifecycle field
      // is present; `in` narrows each member without unsafe field access.
      const kinds = messages.map((m) =>
        "createSurface" in m
          ? "createSurface"
          : "updateComponents" in m
            ? "updateComponents"
            : "updateDataModel" in m
              ? "updateDataModel"
              : "other",
      );
      expect(kinds).toEqual(["createSurface", "updateComponents", "updateDataModel"]);

      surface.apply(messages);
      await flushRender();

      expect(surface.mount.querySelector("acp-message")).not.toBeNull();
    } finally {
      surface.destroy();
    }
  });
});

describe("A2UI user surface_event round-trips to the host sink", () => {
  test("an acp-send DOM event reaches sendSurfaceEvent with surface id, action, and payload", async () => {
    const surface = mountSurface();
    try {
      surface.apply([
        {
          version: "v0.9",
          createSurface: { surfaceId: "chat", catalogId: ACP_CATALOG_ID },
        },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: "chat",
            components: [
              { component: "AcpChatApp", id: "root", promptInput: "pi" },
              {
                component: "AcpPromptInput",
                id: "pi",
                value: { path: "/input" },
                placeholder: "Type a reply...",
                submit: "send",
              },
            ],
          },
        },
        {
          version: "v0.9",
          updateDataModel: { surfaceId: "chat", path: "/input", value: "" },
        },
      ]);
      await flushRender();

      const promptInput = surface.mount.querySelector("acp-prompt-input");
      expect(promptInput).not.toBeNull();

      // Drive the round-trip at the host/renderer seam: the public CustomEvent
      // the live `acp-prompt-input` emits on send. Lit attaches the renderer's
      // `@acp-send` listener during render(), so dispatching it exercises the
      // real action binding rather than the component's shadow internals.
      promptInput?.dispatchEvent(
        new CustomEvent("acp-send", {
          detail: { text: "hello agent" },
          bubbles: true,
          composed: true,
        }),
      );

      expect(surface.events).toHaveLength(1);
      expect(surface.events[0]).toEqual({
        surfaceId: "chat",
        // `submit: "send"` in the payload is what surfaces as the action name.
        actionName: "send",
        payload: { text: "hello agent" },
      });
    } finally {
      surface.destroy();
    }
  });

  test("no interaction means no surface_event is emitted", async () => {
    const surface = mountSurface();
    try {
      surface.apply(buildLandingMessages());
      await flushRender();

      // A pure-display surface (the landing AcpMessage) round-trips nothing
      // back until the operator actually interacts.
      expect(surface.events).toHaveLength(0);
      expect(surface.mount.querySelector("acp-message")).not.toBeNull();
      // Sanity: the reused payload is the landing surface, not some other id.
      const first = buildLandingMessages()[0];
      const landingId = first && "createSurface" in first ? first.createSurface.surfaceId : undefined;
      expect(landingId).toBe(LANDING_SURFACE_ID);
    } finally {
      surface.destroy();
    }
  });
});
