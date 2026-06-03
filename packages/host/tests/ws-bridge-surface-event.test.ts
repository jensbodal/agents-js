import { describe, expect, test } from "bun:test";
import type { ACPSessionController, ACPSessionState } from "@agents-js/acp-host";
import { createWSBridge } from "../src/ws-bridge.ts";

/**
 * The browser → server `surface_event` WS frame is the A2UI back-channel.
 * Before this lands, A2uiBridge sinks logged-and-dropped user clicks.
 *
 * Here we verify the bridge routes:
 *   { type: "surface_event", surfaceId, actionName, payload }
 * to:
 *   controller.sendSurfaceEvent(surfaceId, { action, payload })
 *
 * with the actionName + payload wrapped into the shape the gateway-side
 * surface_event ACPSessionEvent observers expect.
 */

const STUB_STATE: ACPSessionState = {
  sessionId: null,
  status: "ready",
  currentTurn: null,
  completedTurns: [],
  lastError: null,
  pendingWriteGate: null,
  pendingElicitation: null,
  plan: null,
  sessionTitle: null,
  sessionUpdatedAt: null,
  localLabel: null,
  promptQueue: [],
  modes: null,
  modesAdvertisedByAgent: false,
  permissionGatingActive: true,
  hubPath: null,
  availableCommands: null,
  usage: null,
  agentName: null,
  agentCapabilities: null,
} as ACPSessionState;

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("WS open failed")), { once: true });
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("createWSBridge — surface_event back-channel", () => {
  test("routes a browser surface_event frame to controller.sendSurfaceEvent", async () => {
    const calls: Array<{ surfaceId: string; event: unknown }> = [];

    const bridge = createWSBridge({
      controller: {
        permissionMode: "default",
        subscribe() {
          return () => {};
        },
        getState() {
          return STUB_STATE;
        },
        async newSession() {
          return "session-1";
        },
        async loadSession() {
          return "session-1";
        },
        async setRuntime() {},
        async setPermissionMode() {},
        async cancel() {},
        setLastError() {},
        resolveWriteGate() {},
        resolveElicitation() {},
        resolvePermission() {},
        sendSurfaceEvent(surfaceId: string, event: unknown) {
          calls.push({ surfaceId, event });
        },
      } as unknown as ACPSessionController,
      port: 0,
      runtime: { id: "opencode", displayName: "OpenCode ACP" },
    });

    const socket = new WebSocket(`ws://127.0.0.1:${bridge.server.port ?? 0}`);
    try {
      await waitForSocketOpen(socket);

      socket.send(
        JSON.stringify({
          type: "surface_event",
          surfaceId: "surf-1",
          actionName: "submit",
          payload: { name: "ada", count: 3 },
        }),
      );

      await waitFor(() => calls.length === 1);
      expect(calls[0]?.surfaceId).toBe("surf-1");
      expect(calls[0]?.event).toEqual({
        action: "submit",
        payload: { name: "ada", count: 3 },
      });
    } finally {
      socket.close();
      bridge.stop();
    }
  });

  test("preserves opaque payload shape end-to-end (nested objects, arrays, primitives)", async () => {
    const calls: Array<{ surfaceId: string; event: unknown }> = [];

    const bridge = createWSBridge({
      controller: {
        permissionMode: "default",
        subscribe() {
          return () => {};
        },
        getState() {
          return STUB_STATE;
        },
        async newSession() {
          return "session-1";
        },
        async loadSession() {
          return "session-1";
        },
        async setRuntime() {},
        async setPermissionMode() {},
        async cancel() {},
        setLastError() {},
        resolveWriteGate() {},
        resolveElicitation() {},
        resolvePermission() {},
        sendSurfaceEvent(surfaceId: string, event: unknown) {
          calls.push({ surfaceId, event });
        },
      } as unknown as ACPSessionController,
      port: 0,
      runtime: { id: "opencode", displayName: "OpenCode ACP" },
    });

    const socket = new WebSocket(`ws://127.0.0.1:${bridge.server.port ?? 0}`);
    try {
      await waitForSocketOpen(socket);

      const payload = {
        items: [
          { id: 1, label: "alpha" },
          { id: 2, label: "beta" },
        ],
        flag: true,
        ratio: 0.5,
      };

      socket.send(
        JSON.stringify({
          type: "surface_event",
          surfaceId: "surf-2",
          actionName: "select",
          payload,
        }),
      );

      await waitFor(() => calls.length === 1);
      expect((calls[0]?.event as { payload: unknown }).payload).toEqual(payload);
    } finally {
      socket.close();
      bridge.stop();
    }
  });
});
