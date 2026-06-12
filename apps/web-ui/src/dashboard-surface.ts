/**
 * The Gateway Dashboard's initial A2UI surface payload — intentionally EMPTY.
 *
 * Kept in its own side-effect-free module (no DOM bootstrap) so `dashboard.ts`
 * can mount it and a unit test can assert the surface shape — mirroring the
 * `landing-surface.ts` / `a2ui-demo.ts` split.
 *
 * Per the M0 direction ("start with the dashboard being wasm canvas and
 * empty"): the dashboard surface starts as a single empty-state marker. Real
 * content — agent state, registry, health, routing — is layered on later as
 * `UpdateComponents` once the empty canvas proves out. The component used here
 * is an `AcpMessage` (catalog primitive proven to paint on the wasm-canvas
 * `RendererAdapter`), so the same surface drives the Lit renderer and the
 * wasm-canvas renderer without change.
 */
import { type A2uiMessage, ACP_CATALOG_ID } from "@agents-js/a2ui-types";

export const DASHBOARD_SURFACE_ID = "gateway-dashboard";

/** Build the empty Gateway Dashboard surface (`CreateSurface` + empty-state marker). */
export function buildDashboardSurface(): readonly A2uiMessage[] {
  return [
    {
      version: "v0.9",
      createSurface: { surfaceId: DASHBOARD_SURFACE_ID, catalogId: ACP_CATALOG_ID },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: DASHBOARD_SURFACE_ID,
        components: [
          {
            component: "AcpMessage",
            id: "dashboard-empty",
            role: "agent",
            body: "Gateway Dashboard — empty. No agents connected yet.",
          },
        ],
      },
    },
  ];
}
