import { describe, expect, test } from "bun:test";
import { A2UI_WS_FRAME_TYPE } from "@agents-js/a2ui-types";
import { HostWSClient } from "../src/ws-client.ts";
import { mapPendingElicitation, mapSnapshot } from "../src/ws-state-mapper.ts";

type HostWSClientState = ReturnType<HostWSClient["getState"]>;

describe("mapSnapshot", () => {
  test("maps runtime from state snapshots", () => {
    const state = mapSnapshot({
      status: "ready",
      permissionMode: "plan",
      promptQueue: [[{ type: "text", text: "queued" }]],
      runtime: {
        id: "claude",
        displayName: "Claude ACP",
      },
    });

    expect(state).toMatchObject({
      sessionStatus: "ready",
      permissionMode: "plan",
      runtime: {
        id: "claude",
        displayName: "Claude ACP",
      },
      queueCount: 1,
      workflowSurface: {
        composer_surface: {
          mode: "ready",
          queuedFollowUpCount: 1,
        },
      },
    });
  });

  test("maps runtime switch state from snapshots", () => {
    const state = mapSnapshot({
      runtimeSwitchState: {
        status: "runtimeApplied",
        requestedRuntimeId: "claude",
        message: "Switched.",
        origin: "manual",
        preservedSession: true,
        clearedPendingTurn: true,
      },
    });

    expect(state.runtimeSwitchState).toEqual({
      status: "runtimeApplied",
      requestedRuntimeId: "claude",
      message: "Switched.",
      origin: "manual",
      preservedSession: true,
      clearedPendingTurn: true,
    });
    expect(state.workflowSurface?.composer_surface.mode).toBe("idle");
  });

  test("maps active turn summary and workflow surface from state snapshots", () => {
    const state = mapSnapshot({
      status: "prompting",
      permissionMode: "hub",
      sessionId: "session-1",
      sessionTitle: "Review runtime",
      promptQueue: [[{ type: "text", text: "queued" }], [{ type: "text", text: "queued-2" }]],
      currentTurn: {
        textChunks: ["first", "second"],
        toolCalls: {
          tool1: { status: "running" },
          tool2: { status: "failed" },
        },
      },
      plan: [{ content: "Inspect runtime", status: "in_progress", priority: "high" }],
    });

    expect(state.currentTurn).toEqual({
      textChunkCount: 2,
      lastTextChunk: "second",
      toolCallCount: 2,
      activeToolCallCount: 1,
      failedToolCallCount: 1,
    });
    expect(state.queueCount).toBe(2);
    expect(state.workflowSurface).toMatchObject({
      composer_surface: {
        mode: "queueing",
        queuedFollowUpCount: 2,
      },
      transcript_surface: {
        sessionId: "session-1",
        title: "Review runtime",
        hasActiveTurn: true,
        textChunkCount: 2,
      },
      plan_surface: {
        visible: true,
        activeCount: 1,
      },
      activity_surface: {
        phase: "running",
        queuedFollowUpCount: 2,
      },
    });
  });

  test("forwards rich per-call tool data including locations, rawInput, rawOutput", () => {
    // Mirrors the wire shape: ws-bridge JSON-stringifies the host's
    // `Map<string, ToolCallInfo>` to a Record. acp-host populates
    // `richContent` (flattened ToolCallContentInfo) — the mapper has
    // to re-hydrate it back into the SDK's discriminated `ToolCallContent`.
    const state = mapSnapshot({
      currentTurn: {
        textChunks: [],
        toolCalls: {
          "tc-1": {
            id: "tc-1",
            name: "read",
            status: "completed",
            kind: "read",
            richContent: [{ type: "content", text: "file contents here" }],
            locations: [{ path: "/repo/src/index.ts", line: 42 }],
            rawInput: { path: "/repo/src/index.ts" },
            rawOutput: { bytes: 1024 },
          },
          "tc-2": {
            id: "tc-2",
            name: "edit",
            status: "running",
            richContent: [{ type: "diff", diffPath: "a.ts", diffOldText: "x", diffNewText: "y" }],
          },
        },
      },
    });

    expect(state.currentTurn?.toolCalls).toHaveLength(2);
    const [call1, call2] = state.currentTurn?.toolCalls ?? [];
    expect(call1).toMatchObject({
      toolCallId: "tc-1",
      toolName: "read",
      status: "completed",
      toolKind: "read",
      locations: [{ path: "/repo/src/index.ts", line: 42 }],
      rawInput: { path: "/repo/src/index.ts" },
      rawOutput: { bytes: 1024 },
    });
    expect(call1?.content).toEqual([
      { type: "content", content: { type: "text", text: "file contents here" } },
    ]);
    expect(call2?.content).toEqual([{ type: "diff", path: "a.ts", oldText: "x", newText: "y" }]);
  });

  test("normalizes host-internal 'running' status back to ACP 'in_progress'", () => {
    // acp-host's mapToolCallStatus collapses ACP `in_progress` → host
    // `running`. <acp-tool-call-detail> styles ACP-shaped statuses, so
    // the mapper has to invert this on the way out.
    const state = mapSnapshot({
      currentTurn: {
        textChunks: [],
        toolCalls: {
          "tc-1": { id: "tc-1", name: "edit", status: "running" },
        },
      },
    });
    expect(state.currentTurn?.toolCalls?.[0]?.status).toBe("in_progress");
  });

  test("drops malformed rich-content entries instead of fabricating empty placeholders", () => {
    // `content` without text, `diff` without path, `terminal` without
    // terminalId — all invalid per the SDK shape. The mapper used to
    // backfill empty strings; now it filters them out so the detail
    // component doesn't render misleading empty blocks.
    const state = mapSnapshot({
      currentTurn: {
        textChunks: [],
        toolCalls: {
          "tc-1": {
            id: "tc-1",
            name: "read",
            status: "completed",
            richContent: [
              { type: "content" }, // no text → drop
              { type: "diff", diffNewText: "y" }, // no diffPath → drop
              { type: "terminal" }, // no terminalId → drop
              { type: "content", text: "ok" }, // valid → keep
            ],
          },
        },
      },
    });
    expect(state.currentTurn?.toolCalls?.[0]?.content).toEqual([
      { type: "content", content: { type: "text", text: "ok" } },
    ]);
  });

  test("survives null/non-object values inside the toolCalls record", () => {
    // `typeof null === "object"`, so a wire payload like
    // `{ "tc-1": null }` would otherwise crash on `raw.status` access.
    // The defensive guard inside mapToolCallEntry should drop these.
    const state = mapSnapshot({
      currentTurn: {
        textChunks: [],
        toolCalls: {
          "tc-null": null,
          "tc-num": 42,
          "tc-ok": { id: "tc-ok", name: "read", status: "completed" },
        },
      },
    });
    // counts still walk all entries — the active/failed counters
    // runtime-check `status` before reading it, so non-object values
    // are treated as "not active" / "not failed" rather than crashing
    expect(state.currentTurn?.toolCallCount).toBe(3);
    // but only the well-formed entry survives into the rich list
    expect(state.currentTurn?.toolCalls).toHaveLength(1);
    expect(state.currentTurn?.toolCalls?.[0]?.toolCallId).toBe("tc-ok");
  });

  test("skips tool calls missing id/name (defensive — partial wire payloads)", () => {
    const state = mapSnapshot({
      currentTurn: {
        textChunks: [],
        toolCalls: {
          "tc-1": { status: "running" }, // legacy-shape probe; no id/name
        },
      },
    });
    // Counts still work for status-only entries; rich list is empty.
    expect(state.currentTurn?.toolCallCount).toBe(1);
    expect(state.currentTurn?.toolCalls).toBeUndefined();
  });

  test("maps permission scope candidates from pending permission snapshots", () => {
    const state = mapSnapshot({
      currentTurn: {
        pendingPermission: {
          request: {
            toolCall: {
              title: "Write file",
              rawInput: { path: "/workspace/docs/spec.md" },
            },
            suggestedScopes: [
              {
                level: "exact",
                scope: "/workspace/docs/spec.md",
                label: "Just this file: spec.md",
              },
              { level: "workspace", scope: "/workspace/", label: "Entire workspace" },
            ],
          },
        },
      },
    });

    expect(state.pendingPermission?.suggestedScopes).toEqual([
      { level: "exact", scope: "/workspace/docs/spec.md", label: "Just this file: spec.md" },
      { level: "workspace", scope: "/workspace/", label: "Entire workspace" },
    ]);
  });

  test("maps pending elicitation from state snapshots", () => {
    const state = mapSnapshot({
      pendingElicitation: {
        request: {
          mode: "form",
          message: "Confirm action",
          requestedSchema: { type: "object", properties: {} },
        },
      },
    });

    expect(state.pendingElicitation).toEqual({
      mode: "form",
      message: "Confirm action",
      requestedSchema: { type: "object", properties: {} },
    });
  });

  test("maps absent pending elicitation as null", () => {
    const state = mapSnapshot({});
    expect(state.pendingElicitation).toBeNull();
  });
});

describe("mapPendingElicitation", () => {
  test("returns null for non-object inputs", () => {
    expect(mapPendingElicitation(null)).toBeNull();
    expect(mapPendingElicitation(undefined)).toBeNull();
    expect(mapPendingElicitation(42)).toBeNull();
  });

  test("returns null when request.message is missing", () => {
    expect(mapPendingElicitation({ request: { mode: "form" } })).toBeNull();
  });

  test("ignores unknown modes", () => {
    const info = mapPendingElicitation({ request: { mode: "weird", message: "Confirm" } });
    expect(info).toEqual({ message: "Confirm" });
  });
});

describe("HostWSClient", () => {
  test("changing the websocket URL clears stale host state", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      _handleMessage(raw: string): void;
      setUrl(url: string): void;
      getState(): HostWSClientState;
    };

    // Simulate a snapshot arriving over the wire
    client._handleMessage(
      JSON.stringify({
        type: "state_snapshot",
        state: {
          runtime: { id: "opencode", displayName: "OpenCode ACP" },
        },
      }),
    );
    client.setUrl("ws://localhost:55365");

    expect(client.getState()).toEqual({});
  });

  test("setRuntime marks the client as switching before the gateway acknowledges", () => {
    const client = new HostWSClient("ws://localhost:55364");

    client.setRuntime("claude");

    expect(client.getState().runtimeSwitchState).toEqual({
      status: "switching",
      requestedRuntimeId: "claude",
      message: 'Switching runtime to "claude"...',
      origin: "manual",
    });
  });

  test("setRuntime forwards a saved restore origin through the websocket payload", () => {
    const sent: string[] = [];
    const client = new HostWSClient("ws://localhost:55364") as unknown as Pick<
      HostWSClient,
      "setRuntime" | "resolvePermission"
    > & {
      ws: { readyState: number; send(message: string): void } | null;
    };

    client.ws = {
      readyState: 1,
      send(message: string) {
        sent.push(message);
      },
    };

    client.setRuntime("claude", "saved_restore");

    expect(JSON.parse(sent[0] ?? "{}")).toEqual({
      type: "set_runtime",
      runtimeId: "claude",
      origin: "saved_restore",
    });
  });

  test("resolvePermission forwards selectedScope through the websocket payload", () => {
    const sent: string[] = [];
    const client = new HostWSClient("ws://localhost:55364") as unknown as Pick<
      HostWSClient,
      "setRuntime" | "resolvePermission"
    > & {
      ws: { readyState: number; send(message: string): void } | null;
    };

    client.ws = {
      readyState: 1,
      send(message: string) {
        sent.push(message);
      },
    };

    client.resolvePermission({
      response: {
        outcome: { outcome: "selected", optionId: "allow-1" },
      },
      selectedScope: "/workspace/docs/",
    });

    expect(JSON.parse(sent[0] ?? "{}")).toEqual({
      type: "resolve_permission",
      response: {
        outcome: { outcome: "selected", optionId: "allow-1" },
      },
      selectedScope: "/workspace/docs/",
    });
  });

  test("resolveElicitation forwards the response through the websocket payload", () => {
    const sent: string[] = [];
    const client = new HostWSClient("ws://localhost:55364") as unknown as Pick<
      HostWSClient,
      "resolveElicitation"
    > & {
      ws: { readyState: number; send(message: string): void } | null;
    };

    client.ws = {
      readyState: 1,
      send(message: string) {
        sent.push(message);
      },
    };

    client.resolveElicitation({ action: "accept", content: { name: "Jane" } });

    expect(JSON.parse(sent[0] ?? "{}")).toEqual({
      type: "resolve_elicitation",
      response: { action: "accept", content: { name: "Jane" } },
    });
  });

  test("ignores late messages from a stale websocket after retargeting", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      ws: WebSocket | null;
      _handleSocketMessage(ws: WebSocket, raw: string): void;
      getState(): HostWSClientState;
    };

    const activeSocket = {} as WebSocket;
    const staleSocket = {} as WebSocket;
    client.ws = activeSocket;

    client._handleSocketMessage(
      activeSocket,
      JSON.stringify({
        type: "state_snapshot",
        state: {
          runtime: { id: "claude", displayName: "Claude ACP" },
        },
      }),
    );

    client._handleSocketMessage(
      staleSocket,
      JSON.stringify({
        type: "state_snapshot",
        state: {
          runtime: { id: "opencode", displayName: "OpenCode ACP" },
        },
      }),
    );

    expect(client.getState().runtime).toEqual({
      id: "claude",
      displayName: "Claude ACP",
    });
  });

  test("rebuilds authoritative state when an event carries a snapshot", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      _applyEvent(
        event: Record<string, unknown> & { type: string },
        state?: Record<string, unknown>,
      ): void;
      getState(): HostWSClientState;
    };

    client._applyEvent(
      { type: "queue_changed", count: 3 },
      {
        status: "ready",
        promptQueue: [
          [{ type: "text", text: "one" }],
          [{ type: "text", text: "two" }],
          [{ type: "text", text: "three" }],
        ],
      },
    );

    expect(client.getState().queueCount).toBe(3);
    expect(client.getState().workflowSurface?.composer_surface.queuedFollowUpCount).toBe(3);
  });

  test("falls back to targeted patch for queue_changed when no snapshot is attached", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      _applyEvent(event: Record<string, unknown> & { type: string }): void;
      getState(): HostWSClientState;
    };

    client._applyEvent({ type: "queue_changed", count: 3 });

    expect(client.getState().queueCount).toBe(3);
  });

  test("elicitation_requested event populates pendingElicitation", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      _applyEvent(event: Record<string, unknown> & { type: string }): void;
      getState(): HostWSClientState;
    };

    client._applyEvent({
      type: "elicitation_requested",
      request: {
        mode: "form",
        message: "Confirm action",
        requestedSchema: { type: "object" },
      },
    });

    expect(client.getState().pendingElicitation).toEqual({
      mode: "form",
      message: "Confirm action",
      requestedSchema: { type: "object" },
    });
  });

  test("elicitation_resolved event clears pendingElicitation", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      _applyEvent(event: Record<string, unknown> & { type: string }): void;
      getState(): HostWSClientState;
    };

    client._applyEvent({
      type: "elicitation_requested",
      request: { mode: "form", message: "Confirm action" },
    });
    expect(client.getState().pendingElicitation).not.toBeNull();

    client._applyEvent({ type: "elicitation_resolved", action: "accept" });
    expect(client.getState().pendingElicitation).toBeNull();
  });

  test("state_snapshot surfaces pendingElicitation via mapSnapshot", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      _handleMessage(raw: string): void;
      getState(): HostWSClientState;
    };

    client._handleMessage(
      JSON.stringify({
        type: "state_snapshot",
        state: {
          pendingElicitation: {
            request: {
              mode: "form",
              message: "Pick one",
              requestedSchema: { type: "object" },
            },
          },
        },
      }),
    );

    expect(client.getState().pendingElicitation).toEqual({
      mode: "form",
      message: "Pick one",
      requestedSchema: { type: "object" },
    });
  });

  test("forwards a2ui_message frames to onA2uiMessage with the verbatim payload", () => {
    const received: unknown[] = [];
    const client = new HostWSClient("ws://localhost:55364", {
      onA2uiMessage: (message) => {
        received.push(message);
      },
    }) as unknown as { _handleMessage(raw: string): void };

    const payload = {
      messageType: "CreateSurface",
      surfaceId: "s-ws",
      components: [],
      root: null,
      dataModel: {},
    };
    client._handleMessage(JSON.stringify({ type: A2UI_WS_FRAME_TYPE, message: payload }));

    expect(received).toEqual([payload]);
  });

  test("ignores a2ui_message frames when onA2uiMessage is not wired", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      _handleMessage(raw: string): void;
    };

    // Should not throw — exercises the optional-hook branch.
    client._handleMessage(
      JSON.stringify({
        type: A2UI_WS_FRAME_TYPE,
        message: { messageType: "DeleteSurface", surfaceId: "gone" },
      }),
    );
  });

  test("sendSurfaceEvent drops the event when WS is not OPEN (no queueing across reconnect)", () => {
    // Surface events are moment-bound. Queuing them while closed
    // and replaying on the next OPEN would replay user clicks into
    // a later session/runtime. This test pins the drop-on-closed
    // contract.
    const sent: string[] = [];
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      sendSurfaceEvent(s: string, a: string, p: unknown): boolean;
      pendingMessages: Record<string, unknown>[];
      ws: { readyState: number; send(m: string): void } | null;
    };

    // No socket attached → not OPEN. Surface event must drop.
    expect(client.ws).toBeNull();
    const accepted = client.sendSurfaceEvent("surf-1", "submit", { name: "ada" });
    expect(accepted).toBe(false);
    expect(client.pendingMessages).toEqual([]);

    // Even with a CONNECTING socket (readyState 0), the event drops.
    client.ws = {
      readyState: 0, // CONNECTING
      send(message: string) {
        sent.push(message);
      },
    };
    expect(client.sendSurfaceEvent("surf-2", "click", {})).toBe(false);
    expect(sent).toEqual([]);
    expect(client.pendingMessages).toEqual([]);

    // OPEN → delivered, not queued.
    client.ws = {
      readyState: 1,
      send(message: string) {
        sent.push(message);
      },
    };
    expect(client.sendSurfaceEvent("surf-3", "submit", { ok: true })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? "{}")).toEqual({
      type: "surface_event",
      surfaceId: "surf-3",
      actionName: "submit",
      payload: { ok: true },
    });
    expect(client.pendingMessages).toEqual([]);
  });

  test("disconnect drops queued messages so they don't replay on next connect", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      cancel(): void;
      disconnect(): void;
      pendingMessages: Record<string, unknown>[];
      ws: unknown;
    };

    // ws is null → cancel() falls through to pendingMessages.push.
    client.cancel();
    expect(client.pendingMessages.length).toBe(1);

    client.disconnect();
    expect(client.pendingMessages).toEqual([]);
  });
});
