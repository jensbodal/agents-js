/**
 * The root landing's A2UI surface payload.
 *
 * Kept in its own side-effect-free module (no DOM bootstrap) so `main.ts` can
 * mount it and a unit test can assert the surface shape — mirroring the
 * `a2ui-demo.ts` split.
 */
import { type A2uiMessage, ACP_CATALOG_ID } from "@agents-js/a2ui-types";

export const LANDING_SURFACE_ID = "landing";

/**
 * Build the landing's A2UI surface messages — a `CreateSurface` +
 * `UpdateComponents` round-trip that renders a welcome card through the renderer,
 * demonstrating the canvas direction at the root without a live A2UI agent.
 */
export function buildLandingMessages(): readonly A2uiMessage[] {
  return [
    {
      version: "v0.9",
      createSurface: { surfaceId: LANDING_SURFACE_ID, catalogId: ACP_CATALOG_ID },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: LANDING_SURFACE_ID,
        components: [
          {
            component: "AcpMessage",
            id: "welcome",
            role: "agent",
            body: "Welcome to agents-js — your agent, everywhere. This is the A2UI canvas surface at the root; open the chat or inbox below.",
          },
        ],
      },
    },
  ];
}
