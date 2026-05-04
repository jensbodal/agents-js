import { describe, expect, test } from "bun:test";
import { A2UI_WS_FRAME_TYPE } from "@agents-js/a2ui-types";
import { HostWSClient } from "../src/ws-client.ts";
import { mapModels, mapPendingElicitation, mapSnapshot } from "../src/ws-state-mapper.ts";

type HostWSClientState = ReturnType<HostWSClient["getState"]>;

describe("mapSnapshot", () => {
  test("maps runtime and models from state snapshots", () => {
    const state = mapSnapshot({
      status: "ready",
      permissionMode: "plan",
      promptQueue: [[{ type: "text", text: "queued" }]],
      runtime: {
        id: "claude",
        displayName: "Claude ACP",
      },
      models: {
        currentModelId: "gpt-5",
        availableModels: [{ modelId: "gpt-5", name: "GPT-5" }],
      },
    });

    expect(state).toMatchObject({
      sessionStatus: "ready",
      permissionMode: "plan",
      runtime: {
        id: "claude",
        displayName: "Claude ACP",
      },
      models: {
        currentModelId: "gpt-5",
        availableModels: [{ modelId: "gpt-5", name: "GPT-5" }],
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

describe("mapModels", () => {
  test("returns null for non-object input", () => {
    expect(mapModels(null)).toBeNull();
    expect(mapModels(undefined)).toBeNull();
    expect(mapModels("string")).toBeNull();
  });

  test("returns null when currentModelId is missing", () => {
    expect(mapModels({ availableModels: [] })).toBeNull();
  });

  test("filters out invalid model entries", () => {
    const result = mapModels({
      currentModelId: "gpt-5",
      availableModels: [{ modelId: "gpt-5", name: "GPT-5" }, null, "invalid", { noModelId: true }],
    });

    expect(result).toEqual({
      currentModelId: "gpt-5",
      availableModels: [{ modelId: "gpt-5", name: "GPT-5" }],
    });
  });
});

describe("HostWSClient", () => {
  test("updates model state from model_changed events without an attached snapshot", () => {
    const client = new HostWSClient("ws://localhost:55364") as unknown as {
      _applyEvent(event: Record<string, unknown> & { type: string }): void;
      getState(): HostWSClientState;
    };

    client._applyEvent({
      type: "model_changed",
      models: {
        currentModelId: "opus",
        availableModels: [
          { modelId: "gpt-5", name: "GPT-5" },
          { modelId: "opus", name: "Opus" },
        ],
      },
    });

    expect(client.getState().models).toEqual({
      currentModelId: "opus",
      availableModels: [
        { modelId: "gpt-5", name: "GPT-5" },
        { modelId: "opus", name: "Opus" },
      ],
    });
  });

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
          models: {
            currentModelId: "gpt-5",
            availableModels: [{ modelId: "gpt-5", name: "GPT-5" }],
          },
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
});
