import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ACPSessionController } from "@agents-js/acp-host";
import { createWSBridge, type WSBridgeHandle } from "@agents-js/host";
import {
  createGatewayTestServer,
  type GatewayTestServerHandle,
  getMockAgentPath,
  LEARNING_TEST_TIMEOUT_MS,
  waitFor,
} from "@agents-js/host/testing";
import { type HostState, HostWSClient } from "@agents-js/ui-components";

/**
 * Learning test (LT-7): the gateway WebSocket bridge live-state round-trip,
 * end-to-end.
 *
 * Proves the bridge that connects a browser to a running gateway controller:
 *
 *   1. A browser `HostWSClient` connects to `createWSBridge` and receives an
 *      initial **state snapshot** (the bridge replies to the client's
 *      on-open `request_state` with a `state_snapshot` frame, which the
 *      client maps into its flat `HostState`).
 *   2. The controller emits a **gate event** mid-turn (an `elicitation`
 *      request raised by the mock agent). The bridge forwards it to the
 *      client as an `event` frame; the client surfaces it in `HostState`.
 *   3. The client **resolves** the gate. The resolution travels back over
 *      the socket, reaches the controller, and unblocks the in-flight turn —
 *      proving the full browser → bridge → controller → agent loop closes.
 *   4. A `set_runtime` message flips the lane/card; the client observes the
 *      new runtime in its mapped `HostState`.
 *
 * The controller is backed by `tests/mock-acp-agent.cjs` spawned as a real
 * `node` subprocess (the same fixture `createGatewayTestServer` uses) — the
 * ACP transport is genuine, nothing here stubs it. The elicitation gate
 * stands in for the GOAL's "permission (or write-gate)" event: the `.cjs`
 * fixture exposes a deterministic elicitation probe (`"browser smoke
 * elicitation accept"`) but no raw `session/request_permission`, so the
 * elicitation request/resolve pair is the controller gate this smoke
 * round-trips. Its wire shape on the bridge is identical: the controller
 * emits a gate event, the bridge forwards it, the client resolves it, and
 * the resolution reaches the controller.
 *
 * The controller comes from `createGatewayTestServer`, which now exposes its
 * factory-owned `controller` on the handle. The bridge attaches to that
 * controller directly; the factory's A2A server stays idle (no A2A requests
 * are made here). The factory is invoked with `permissionMode: "default"`
 * (not the `bypassPermissions` test default) so the elicitation gate actually
 * fires and round-trips through the bridge rather than auto-resolving. The
 * bridge wiring mirrors `packages/host/tests/ws-bridge.test.ts`'s
 * `createLiveBridgeHarness`, swapping in the real browser `HostWSClient` (the
 * GOAL's reuse target) for the raw socket used there.
 */

const INITIAL_RUNTIME = { id: "opencode", displayName: "OpenCode ACP" };
const SWAPPED_RUNTIME = { id: "claude", displayName: "Claude ACP" };

describe("ws-bridge-smoke", () => {
  let gateway: GatewayTestServerHandle;
  let controller: ACPSessionController;
  let bridge: WSBridgeHandle;
  let client: HostWSClient;
  // Latest HostState pushed by the client's subscription, for assertions.
  let latest: HostState = {};

  beforeEach(async () => {
    // "default" (not "bypassPermissions") so controller gates actually fire
    // and round-trip through the bridge rather than auto-resolving. The
    // bridge attaches to the factory-owned controller exposed on the handle.
    gateway = await createGatewayTestServer({
      acpCommand: "node",
      acpArgs: [getMockAgentPath()],
      permissionMode: "default",
    });
    controller = gateway.controller;

    bridge = createWSBridge({
      controller,
      port: 0,
      runtime: INITIAL_RUNTIME,
      availableRuntimes: [INITIAL_RUNTIME, SWAPPED_RUNTIME],
      // A real hot-swap handler so `set_runtime` flips the card end-to-end.
      setRuntime: async (runtimeId: string) => ({
        runtime: runtimeId === SWAPPED_RUNTIME.id ? SWAPPED_RUNTIME : INITIAL_RUNTIME,
        preservedSession: true,
        clearedPendingTurn: false,
      }),
    });

    const port = bridge.server.port ?? 0;
    client = new HostWSClient(`ws://127.0.0.1:${port}`);
    client.subscribe((state) => {
      latest = state;
    });
    client.connect();
  });

  afterEach(async () => {
    // Tear down the bridge/client (built on the controller) BEFORE the gateway
    // stops — gateway.stop() destroys the factory-owned controller and removes
    // its workspace.
    client.disconnect();
    bridge.stop();
    await gateway.stop();
  });

  // Intent: the live-state snapshot + gate round-trip, end-to-end. The browser
  // client connects, observes the initial snapshot, the controller raises a
  // gate mid-turn that the bridge forwards, the client resolves it, and the
  // resolution reaches the controller — closing the loop the production web UI
  // relies on.
  test(
    "snapshot on connect, then a gate event round-trips client <-> controller",
    async () => {
      // 1. Initial state snapshot. On open the client sends `request_state`;
      //    the bridge replies with a `state_snapshot` the client maps into
      //    HostState. The runtime card proves the bridge's snapshot (not just
      //    an empty default) populated the client.
      await waitFor(() => latest.runtime?.id === INITIAL_RUNTIME.id);
      expect(latest.runtime).toEqual(INITIAL_RUNTIME);
      // No gate is pending before the turn starts.
      expect(latest.pendingElicitation ?? null).toBeNull();

      // Open a session so the controller can run a turn.
      const sessionId = await controller.newSession();
      expect(sessionId).toBe("mock-session-123");

      // 2. Drive a turn whose prompt makes the mock raise an elicitation gate.
      //    sendPrompt does not resolve until the gate is resolved, so hold the
      //    promise and await the round-trip in between.
      const turn = controller.sendPrompt([
        { type: "text", text: "browser smoke elicitation accept" },
      ]);

      // The controller emits `elicitation_requested`; the bridge forwards it as
      // an `event` frame carrying a full state snapshot, which the client maps
      // into `pendingElicitation`. Seeing it in HostState proves the
      // controller → bridge → client leg.
      await waitFor(() => latest.pendingElicitation != null);
      expect(latest.pendingElicitation?.message).toContain("browser smoke fixture");
      // Controller-side: the gate really is pending on the controller.
      expect(controller.getState().pendingElicitation).not.toBeNull();

      // 3. Resolve from the browser. The resolution travels client → bridge →
      //    controller; the controller hands it to the agent, which finishes
      //    the turn. `turn` resolving is the controller-side proof the
      //    resolution arrived.
      client.resolveElicitation({ action: "accept", content: { topic: "ws-bridge smoke" } });

      await turn;

      // Controller cleared its pending gate and completed the turn. The turn
      // only finishes once the mock subprocess receives the elicitation
      // response (its `handleElicitationResponse` is the sole caller of the
      // prompt reply), so `await turn` resolving above already proved the
      // resolution round-tripped browser → bridge → controller → agent.
      expect(controller.getState().pendingElicitation).toBeNull();
      expect(controller.getState().status).toBe("ready");
      const completed = controller.getState().completedTurns.at(-1);
      if (!completed) throw new Error("expected a completed turn after resolving the gate");
      // The agent emitted a non-empty reply for the resolved turn. We do not
      // assert the reply *text*: the `.cjs` fixture reads the elicitation
      // response at the nested `result.action.action` path while the current
      // ACP SDK sends the flat `{ action, content }` shape, so the fixture's
      // accept-branch copy is wire-shape-skewed. The bridge round-trip — not
      // the agent's semantic reply — is what this smoke proves.
      expect(completed.textChunks.join("").length).toBeGreaterThan(0);

      // Client-side: the bridge broadcast the resolution snapshot, clearing the
      // pending gate in HostState too.
      await waitFor(() => (latest.pendingElicitation ?? null) === null);
    },
    LEARNING_TEST_TIMEOUT_MS,
  );

  // Intent: a `set_runtime` message flips the lane/card end-to-end. The client
  // sends the swap, the bridge's runtime coordinator applies it, and the
  // client observes the new runtime in its mapped HostState.
  test(
    "set_runtime flips the runtime card and broadcasts it back to the client",
    async () => {
      await waitFor(() => latest.runtime?.id === INITIAL_RUNTIME.id);

      client.setRuntime(SWAPPED_RUNTIME.id);

      // The bridge applies the swap and broadcasts a snapshot carrying the new
      // runtime + a `runtimeApplied` switch state.
      await waitFor(() => latest.runtime?.id === SWAPPED_RUNTIME.id);
      expect(latest.runtime).toEqual(SWAPPED_RUNTIME);
      expect(latest.runtimeSwitchState?.status).toBe("runtimeApplied");
      expect(latest.runtimeSwitchState?.requestedRuntimeId).toBe(SWAPPED_RUNTIME.id);
    },
    LEARNING_TEST_TIMEOUT_MS,
  );
});
