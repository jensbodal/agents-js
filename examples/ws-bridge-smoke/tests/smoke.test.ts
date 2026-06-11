import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ACPSessionController,
  createNodeFileAdapters,
  PermissionEngine,
  PermissionStore,
} from "@agents-js/acp-host";
import { createWSBridge, type WSBridgeHandle } from "@agents-js/host";
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
 * NOTE: this example builds the controller + bridge directly rather than via
 * `createGatewayTestServer`. That factory does not expose its controller
 * (the bridge needs it) and defaults to `bypassPermissions` (which would
 * auto-resolve the very gate we want to round-trip). The direct construction
 * mirrors `packages/host/tests/ws-bridge.test.ts`'s `createLiveBridgeHarness`,
 * the established WS-bridge test pattern, while swapping in the real browser
 * `HostWSClient` (the GOAL's reuse target) for the raw socket used there.
 */

// Repo-root mock ACP agent fixture (../../../tests from this example dir).
const MOCK_AGENT = resolve(import.meta.dir, "../../../tests/mock-acp-agent.cjs");

// Real subprocess spawn + ACP handshake + a live WebSocket round-trip is
// slower than the bun:test 5s default.
const TEST_TIMEOUT_MS = 20_000;

const INITIAL_RUNTIME = { id: "opencode", displayName: "OpenCode ACP" };
const SWAPPED_RUNTIME = { id: "claude", displayName: "Claude ACP" };

/** Poll `predicate` until it holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 10): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await Bun.sleep(stepMs);
  }
}

describe("ws-bridge-smoke", () => {
  let controller: ACPSessionController;
  let bridge: WSBridgeHandle;
  let client: HostWSClient;
  let workspacePath: string;
  // Latest HostState pushed by the client's subscription, for assertions.
  let latest: HostState = {};

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), "ws-bridge-smoke-"));
    controller = new ACPSessionController();
    await controller.start({
      agentConfig: {
        name: "ws-bridge-smoke",
        command: "node",
        args: [MOCK_AGENT],
        env: {},
        authHints: [],
        workspacePolicy: "workspace-root-only",
        // The mock resolves `node` from the real PATH, so the spawn must not
        // run under a sandboxed home (mirrors createGatewayTestServer).
        allowRealHome: true,
      },
      workspacePath,
      fileAdapters: createNodeFileAdapters(workspacePath),
      permissionEngine: new PermissionEngine(),
      permissionStore: new PermissionStore(),
      clientInfo: { name: "ws-bridge-smoke", version: "0.1.0" },
    });
    // "default" (not "bypassPermissions") so controller gates actually fire
    // and round-trip through the bridge rather than auto-resolving.
    await controller.setPermissionMode("default");

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
    client.disconnect();
    bridge.stop();
    // Destroy kills the spawned subprocess; without it the child leaks and the
    // runner can hang on teardown.
    controller.destroy();
    await rm(workspacePath, { recursive: true, force: true });
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
    TEST_TIMEOUT_MS,
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
    TEST_TIMEOUT_MS,
  );
});
