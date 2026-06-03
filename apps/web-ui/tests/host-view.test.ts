import { describe, expect, test } from "bun:test";
import { routeHostBridgeView } from "../src/host-view.ts";

/**
 * DOT-532 regression: when the host bridge is active (AG-UI mode), the agent
 * transcript carried by the host-bridge state must reach the chat view. The
 * pre-fix `applyHostState` only updated `status` and dropped the transcript,
 * so the chat stayed on "Waiting for messages..." regardless of runtime.
 */
describe("routeHostBridgeView", () => {
  const baseView = {
    status: "idle",
    transcript: [] as Array<{ id: string; role: string; text: string }>,
    pendingText: "",
    other: "preserved",
  };

  test("host bridge active: routes transcript + pendingText into the view", () => {
    const next = routeHostBridgeView(baseView, {
      showHostState: true,
      displayedStatus: "connected",
      transcript: [
        { id: "u-1", role: "user", text: "hello" },
        { id: "a-1", role: "agent", text: "hi there" },
      ],
      pendingAgentText: "streaming…",
    });

    expect(next.status).toBe("connected");
    expect(next.transcript).toEqual([
      { id: "u-1", role: "user", text: "hello" },
      { id: "a-1", role: "agent", text: "hi there" },
    ]);
    expect(next.pendingText).toBe("streaming…");
    expect(next.other).toBe("preserved");
  });

  test("host bridge active with null transcript: empties rather than leaving stale", () => {
    const next = routeHostBridgeView(
      { ...baseView, transcript: [{ id: "x", role: "agent", text: "stale" }], pendingText: "x" },
      {
        showHostState: true,
        displayedStatus: "connected",
        transcript: null,
        pendingAgentText: null,
      },
    );

    expect(next.transcript).toEqual([]);
    expect(next.pendingText).toBe("");
  });

  test("host bridge inactive: preserves the controller-derived transcript, only status changes", () => {
    const prev = {
      ...baseView,
      status: "idle",
      transcript: [{ id: "c-1", role: "agent", text: "from A2A controller" }],
      pendingText: "controller pending",
    };
    const next = routeHostBridgeView(prev, {
      showHostState: false,
      displayedStatus: "connected",
      // Host-bridge values present but must be ignored when inactive.
      transcript: [{ id: "h-1", role: "agent", text: "should be ignored" }],
      pendingAgentText: "ignored",
    });

    expect(next.status).toBe("connected");
    expect(next.transcript).toEqual([{ id: "c-1", role: "agent", text: "from A2A controller" }]);
    expect(next.pendingText).toBe("controller pending");
  });
});
