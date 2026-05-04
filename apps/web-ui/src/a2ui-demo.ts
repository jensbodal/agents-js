/**
 * Dev-only smoke script for the A2UI pipeline.
 *
 * Guarded in `main.ts` behind `?a2ui=demo` + `import.meta.env.DEV`, this
 * module injects a scripted CreateSurface -> UpdateComponents ->
 * UpdateDataModel -> DeleteSurface sequence through
 * {@link A2uiBridge.applyInbound} to prove the host, validator,
 * processor, and renderer all round-trip correctly without needing a
 * live A2UI-emitting agent.
 */
import type { A2uiBridge } from "@agents-js/a2ui-host";
import { type A2uiMessage, ACP_CATALOG_ID } from "@agents-js/a2ui-types";

const DEMO_SURFACE_ID = "demo-chat";

/**
 * Build the scripted message sequence. Exported so tests can drive the
 * host with the same payload shapes the live demo uses.
 */
export function buildDemoMessages(): readonly A2uiMessage[] {
  return [
    {
      version: "v0.9",
      createSurface: {
        surfaceId: DEMO_SURFACE_ID,
        catalogId: ACP_CATALOG_ID,
      },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: DEMO_SURFACE_ID,
        components: [
          {
            component: "AcpMessage",
            id: "root",
            role: "agent",
            body: "Hello from the A2UI demo surface!",
          },
        ],
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: DEMO_SURFACE_ID,
        path: "/input",
        value: "",
      },
    },
  ];
}

/**
 * Run the scripted CreateSurface / UpdateComponents / UpdateDataModel
 * sequence against the supplied bridge. The final DeleteSurface is
 * deferred so the surface stays mounted for the operator to inspect
 * in the browser. Callers who want a full round-trip (create ->
 * delete) should call {@link teardownDemo} afterwards.
 */
export function runDemo(bridge: A2uiBridge): void {
  for (const msg of buildDemoMessages()) {
    bridge.applyInbound(msg);
  }
}

/** Tear down the demo surface; pairs with {@link runDemo}. */
export function teardownDemo(bridge: A2uiBridge): void {
  bridge.applyInbound({
    version: "v0.9",
    deleteSurface: { surfaceId: DEMO_SURFACE_ID },
  });
}
