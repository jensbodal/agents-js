import { describe, expect, test } from "bun:test";
import { buildLandingMessages, LANDING_SURFACE_ID } from "../src/landing-surface.ts";

describe("root landing surface", () => {
  test("creates then populates a single A2UI surface (canvas direction at root)", () => {
    // WHAT: the root `/` landing renders through the a2ui-renderer pipeline
    // (CreateSurface -> UpdateComponents), not the chat app.
    // WHY: Target 1 — root is the A2UI/canvas landing; chat moved to /chat.
    const messages = buildLandingMessages();

    const create = messages.find((m) => "createSurface" in m);
    expect(create?.createSurface?.surfaceId).toBe(LANDING_SURFACE_ID);

    const update = messages.find((m) => "updateComponents" in m);
    expect(update?.updateComponents?.surfaceId).toBe(LANDING_SURFACE_ID);
    const components = update?.updateComponents?.components ?? [];
    expect(components[0]?.component).toBe("AcpMessage");
    expect(components[0]).toMatchObject({ role: "agent" });
  });

  test("every message targets the same surface id", () => {
    for (const message of buildLandingMessages()) {
      const surfaceId =
        message.createSurface?.surfaceId ?? message.updateComponents?.surfaceId ?? null;
      expect(surfaceId).toBe(LANDING_SURFACE_ID);
    }
  });
});
