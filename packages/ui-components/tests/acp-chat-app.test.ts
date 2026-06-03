import { describe, expect, test } from "bun:test";
import { AcpChatApp } from "../src/acp-chat-app.ts";

describe("AcpChatApp", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpChatApp).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpChatApp.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpChatApp.styles)).toBe(true);
  });

  test("has reactive property for controller", () => {
    const props = AcpChatApp.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("controller")).toBeDefined();
  });

  test("controller property does not reflect to attribute", () => {
    expect(AcpChatApp.elementProperties.get("controller")?.attribute).toBe(false);
  });

  test("has reactive property for defaultUrl", () => {
    expect(AcpChatApp.elementProperties.get("defaultUrl")).toBeDefined();
  });

  test("defaultUrl property has String type", () => {
    expect(AcpChatApp.elementProperties.get("defaultUrl")?.type).toBe(String);
  });

  test("has 15 element properties (2 public + 13 state)", () => {
    expect(AcpChatApp.elementProperties.size).toBe(15);
  });

  test("consolidated _view state is registered", () => {
    const meta = AcpChatApp.elementProperties.get("_view");
    expect(meta).toBeDefined();
    expect(meta?.state).toBe(true);
  });

  test("non-derived state properties are registered", () => {
    const stateNames = [
      "_connectError",
      "_connecting",
      "_runtime",
      "_availableRuntimes",
      "_runtimeNotice",
      "_workflowSurface",
      "_currentToolCalls",
      "_hasSavedPreferences",
      "_savedPreferences",
      "_profiles",
      "_activeProfileId",
      "_profileDraftName",
    ];
    for (const name of stateNames) {
      const meta = AcpChatApp.elementProperties.get(name);
      expect(meta).toBeDefined();
      expect(meta?.state).toBe(true);
    }
  });

  test("prototype has render method", () => {
    expect(typeof AcpChatApp.prototype.render).toBe("function");
  });

  test("prototype has connectedCallback", () => {
    expect(typeof AcpChatApp.prototype.connectedCallback).toBe("function");
  });

  test("prototype has disconnectedCallback", () => {
    expect(typeof AcpChatApp.prototype.disconnectedCallback).toBe("function");
  });
});

describe("AcpChatApp internal state", () => {
  test("prototype has _view accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpChatApp.prototype, "_view");
    expect(descriptor).toBeDefined();
  });

  test("prototype has _connectError accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpChatApp.prototype, "_connectError");
    expect(descriptor).toBeDefined();
  });

  test("prototype has _runtime accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpChatApp.prototype, "_runtime");
    expect(descriptor).toBeDefined();
  });

  test("prototype has _workflowSurface accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpChatApp.prototype, "_workflowSurface");
    expect(descriptor).toBeDefined();
  });

  test("_view defaults contain expected fields", () => {
    const app = new AcpChatApp() as AcpChatApp & { _view: Record<string, unknown> };
    expect(app._view.status).toBe("idle");
    expect(app._view.connected).toBe(false);
    expect(app._view.inputDisabled).toBe(true);
    expect(app._view.sessionId).toBe("");
    expect(app._view.agentName).toBe("");
    expect(app._view.permissionMode).toBe("ask");
    expect(app._view.transcript).toEqual([]);
    expect(app._view.plan).toEqual([]);
    expect(app._view.lastError).toBe("");
  });
});

describe("AcpChatApp transcript merge (Layer D)", () => {
  // The wire path Layer C established: HostState.currentTurn.toolCalls
  // arrives at acp-chat-app as `_currentToolCalls`. The chat-app merges
  // those into `_view.transcript` (text messages) so <acp-transcript>
  // sees a single TranscriptEntryLike[] array with both kinds.

  test("returns the message stream verbatim when no tool calls are active", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { transcript: unknown[] };
      _currentToolCalls: unknown[];
      _renderedTranscript: unknown[];
    };
    app._view = {
      ...app._view,
      transcript: [
        { id: "m1", role: "user", text: "hi" },
        { id: "m2", role: "agent", text: "hello" },
      ],
    } as typeof app._view;
    app._currentToolCalls = [];
    expect(app._renderedTranscript).toHaveLength(2);
    // Same array reference — no allocation when there's nothing to merge.
    expect(app._renderedTranscript).toBe(app._view.transcript);
  });

  test("memoizes the merged array — repeat reads return the same reference", () => {
    // Streaming `pendingText` triggers many renders that don't touch the
    // transcript or tool-calls inputs. The getter must return a stable
    // reference across those reads so <acp-transcript> doesn't see a
    // spurious change and re-render its child rows.
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { transcript: unknown[] };
      _currentToolCalls: unknown[];
      _renderedTranscript: unknown[];
    };
    app._view = {
      ...app._view,
      transcript: [{ id: "m1", role: "user", text: "x" }],
    } as typeof app._view;
    app._currentToolCalls = [{ toolCallId: "tc-1", toolName: "read", status: "in_progress" }];
    const first = app._renderedTranscript;
    const second = app._renderedTranscript;
    expect(second).toBe(first);
    // Mutating the tool-calls reference invalidates the cache.
    app._currentToolCalls = [...app._currentToolCalls];
    expect(app._renderedTranscript).not.toBe(first);
  });

  test("appends active tool calls as `kind: 'tool_call'` entries after messages", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { transcript: unknown[] };
      _currentToolCalls: unknown[];
      _renderedTranscript: Array<{ id: string; kind?: string }>;
    };
    app._view = {
      ...app._view,
      transcript: [{ id: "m1", role: "user", text: "read package.json" }],
    } as typeof app._view;
    app._currentToolCalls = [
      {
        toolCallId: "tc-1",
        toolName: "read",
        status: "in_progress",
      },
    ];
    const rendered = app._renderedTranscript;
    expect(rendered).toHaveLength(2);
    expect(rendered[0]?.id).toBe("m1");
    expect(rendered[1]).toMatchObject({
      id: "tool:tc-1",
      kind: "tool_call",
    });
  });
});

describe("AcpChatApp private methods", () => {
  test("prototype has _handleConnect method", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleConnect).toBe(
      "function",
    );
  });

  test("prototype has _handleSend method", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleSend).toBe("function");
  });

  test("prototype has _handleTargetUrlChange method", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleTargetUrlChange).toBe(
      "function",
    );
  });

  test("prototype has _handleElicitationResponse method", () => {
    expect(
      typeof (AcpChatApp.prototype as Record<string, unknown>)._handleElicitationResponse,
    ).toBe("function");
  });

  test("prototype has _handleAuthSelected method", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleAuthSelected).toBe(
      "function",
    );
  });

  test("prototype has _applyState method", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._applyState).toBe("function");
  });

  test("queues default target sync outside the current update cycle", async () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { connected: boolean };
      updated(changed: Map<string, unknown>): void;
      _syncDefaultTargetInput(): void;
    };
    let syncCalls = 0;

    Object.defineProperty(app, "isConnected", {
      configurable: true,
      value: true,
    });
    app._syncDefaultTargetInput = () => {
      syncCalls += 1;
    };

    app.updated(new Map([["defaultUrl", ""]]));

    expect(syncCalls).toBe(0);
    await Promise.resolve();
    expect(syncCalls).toBe(1);
  });

  test("prototype has _targetStatusMessage method", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._targetStatusMessage).toBe(
      "function",
    );
  });

  test("_targetStatusMessage includes inspection errors by default", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { sessionState: { targetInspection?: { status: string; error?: string } } };
      _targetStatusMessage(): string;
    };

    app._view = {
      ...app._view,
      sessionState: {
        targetInspection: {
          status: "unreachable",
          error: "Failed to fetch",
        },
      },
    };

    expect(app._targetStatusMessage()).toBe("Waiting for agent card... (Failed to fetch)");
  });

  test("_targetStatusMessage gives paired launcher targets an actionable unreachable message", () => {
    // WHAT: paired launcher URLs should hide raw browser transport errors but
    // still clearly tell the user the gateway is unreachable.
    // WHY: manual UI QA found a bad local gateway stayed on vague "Waiting"
    // copy forever, which looked like loading instead of a connection failure.
    const app = new AcpChatApp() as AcpChatApp & {
      suppressProbeErrorDetails: boolean;
      _view: { sessionState: { targetInspection?: { status: string; error?: string } } };
      _targetStatusMessage(): string;
    };

    app.suppressProbeErrorDetails = true;
    app._view = {
      ...app._view,
      sessionState: {
        targetInspection: {
          status: "unreachable",
          error: "Failed to fetch",
        },
      },
    };

    expect(app._targetStatusMessage()).toBe(
      "Unable to reach the agent card. Check the gateway URL and that the local gateway is running.",
    );
  });

  test("prototype has _handleSettings method", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleSettings).toBe(
      "function",
    );
  });

  test("prototype has _handleDisconnect method", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleDisconnect).toBe(
      "function",
    );
  });

  test("prototype has profile management methods", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleProfileSelected).toBe(
      "function",
    );
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleProfileDeleted).toBe(
      "function",
    );
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleProfileNameChange).toBe(
      "function",
    );
  });

  test("prototype derives contextual prompt placeholders", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._promptPlaceholder).toBe(
      "function",
    );
  });
});

describe("AcpChatApp _connecting state", () => {
  test("prototype has _connecting accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpChatApp.prototype, "_connecting");
    expect(descriptor).toBeDefined();
  });

  test("_connecting defaults to false", () => {
    const app = new AcpChatApp() as AcpChatApp & { _connecting: boolean };
    expect(app._connecting).toBe(false);
  });

  test("_connecting is registered as state property", () => {
    const meta = AcpChatApp.elementProperties.get("_connecting");
    expect(meta).toBeDefined();
    expect(meta?.state).toBe(true);
  });

  test("_handleConnect sets _connecting true then false on success", async () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _connecting: boolean;
      _connectError: string;
      _runtimeNotice: string;
      _view: Record<string, unknown>;
      _handleConnect(e: Event): Promise<void>;
    };

    let connectingDuringCall = false;
    const mockCard = { name: "TestAgent" };
    app.controller = {
      subscribe: () => () => {},
      getState: () => ({}),
      setTargetInput: () => {},
      clearTargetInput: () => {},
      connect: async () => {
        connectingDuringCall = app._connecting;
        return { card: mockCard };
      },
      sendTurn: async () => ({}),
      respondToElicitation: async () => {},
      respondToAuthRequired: async () => {},
    };
    app._runtimeNotice = "some notice";
    app._view = { ...app._view, sessionState: { targetInput: { url: "http://localhost:55363" } } };

    const event = new CustomEvent("acp-connect", { detail: { url: "http://localhost:55363" } });
    await app._handleConnect(event);

    expect(connectingDuringCall).toBe(true);
    expect(app._connecting).toBe(false);
    expect(app._runtimeNotice).toBe("");
  });

  test("_handleConnect sets _connecting false on error", async () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _connecting: boolean;
      _connectError: string;
      _view: Record<string, unknown>;
      _handleConnect(e: Event): Promise<void>;
    };

    app.controller = {
      subscribe: () => () => {},
      getState: () => ({}),
      setTargetInput: () => {},
      clearTargetInput: () => {},
      connect: async () => {
        throw new Error("Network failure");
      },
      sendTurn: async () => ({}),
      respondToElicitation: async () => {},
      respondToAuthRequired: async () => {},
    };
    app._view = { ...app._view, sessionState: {} };

    const event = new CustomEvent("acp-connect", { detail: { url: "http://localhost:55363" } });
    await app._handleConnect(event);

    expect(app._connecting).toBe(false);
    expect(app._connectError).toBe("Network failure");
  });
});

describe("AcpChatApp _handleRetry", () => {
  test("prototype has _handleRetry method", () => {
    expect(typeof (AcpChatApp.prototype as Record<string, unknown>)._handleRetry).toBe("function");
  });

  test("_handleRetry clears _connectError", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _connectError: string;
      _handleRetry(): void;
    };

    app._connectError = "Something went wrong";
    app._handleRetry();

    expect(app._connectError).toBe("");
  });
});

describe("AcpChatApp theming contract", () => {
  const stylesText = (Array.isArray(AcpChatApp.styles) ? AcpChatApp.styles : [AcpChatApp.styles])
    .map((s) => String((s as { cssText?: string }).cssText ?? s))
    .join("\n");

  test("declares --acp-chat-app-* tokens on :host", () => {
    for (const token of ["--acp-chat-app-bg", "--acp-chat-app-color"]) {
      expect(stylesText).toContain(token);
    }
  });

  test("declares --acp-session-toolbar-* tokens on :host", () => {
    for (const token of [
      "--acp-session-toolbar-bg",
      "--acp-session-toolbar-border",
      "--acp-session-toolbar-padding",
      "--acp-session-toolbar-gap",
    ]) {
      expect(stylesText).toContain(token);
    }
  });

  test("source includes named slots for all composite regions", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(new URL("../src/acp-chat-app.ts", import.meta.url), "utf8");
    for (const slot of [
      'slot name="header"',
      'slot name="footer"',
      'slot name="status-bar"',
      'slot name="transcript"',
      'slot name="prompt-input"',
      'slot name="overlays"',
    ]) {
      expect(src).toContain(slot);
    }
  });
});

describe("AcpChatApp error recovery input enabling", () => {
  test("_applyState enables input when status is error with valid target", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { inputDisabled: boolean };
      _applyState(state: Record<string, unknown>): void;
    };

    app._applyState({
      status: "error",
      target: { url: "http://localhost:55363", card: { name: "Agent" } },
    });

    expect(app._view.inputDisabled).toBe(false);
  });

  test("_applyState disables input when status is error without target", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { inputDisabled: boolean };
      _applyState(state: Record<string, unknown>): void;
    };

    app._applyState({ status: "error" });

    expect(app._view.inputDisabled).toBe(true);
  });

  test("_applyState enables input when status is connected", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { inputDisabled: boolean };
      _applyState(state: Record<string, unknown>): void;
    };

    app._applyState({ status: "connected" });

    expect(app._view.inputDisabled).toBe(false);
  });

  test("_applyState disables input when status is idle", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { inputDisabled: boolean };
      _applyState(state: Record<string, unknown>): void;
    };

    app._applyState({ status: "idle" });

    expect(app._view.inputDisabled).toBe(true);
  });
});

describe("AcpChatApp runtimeNotice clearing on connect", () => {
  test("_handleConnect clears _runtimeNotice on success", async () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _runtimeNotice: string;
      _view: Record<string, unknown>;
      _handleConnect(e: Event): Promise<void>;
    };

    const mockCard = { name: "Agent" };
    app.controller = {
      subscribe: () => () => {},
      getState: () => ({}),
      setTargetInput: () => {},
      clearTargetInput: () => {},
      connect: async () => ({ card: mockCard }),
      sendTurn: async () => ({}),
      respondToElicitation: async () => {},
      respondToAuthRequired: async () => {},
    };
    app._runtimeNotice = "Runtime mismatch warning";
    app._view = { ...app._view, sessionState: {} };

    const event = new CustomEvent("acp-connect", { detail: { url: "http://localhost:55363" } });
    await app._handleConnect(event);

    expect(app._runtimeNotice).toBe("");
  });
});

describe("AcpChatApp settings/disconnect flow", () => {
  test("_handleSettings sets connected to false in _view", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: { connected: boolean; agentName: string };
      _handleSettings(): void;
    };

    app._view = { ...app._view, connected: true, agentName: "TestAgent" };

    app._handleSettings();

    expect(app._view.connected).toBe(false);
  });

  test("render keeps the connect dialog editable after Settings even when a session id still exists", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: Record<string, unknown>;
      render(): {
        values: unknown[];
      };
    };

    app._view = { ...app._view, connected: false, sessionId: "test-session-123" };

    const template = app.render();
    const connectDialogTemplate = template.values[1] as { values: unknown[] };

    expect(connectDialogTemplate.values[0]).toBe(false);
  });

  test("_handleDisconnect resets session state and dispatches event", () => {
    const app = new AcpChatApp() as AcpChatApp & {
      _view: {
        connected: boolean;
        sessionId: string;
        transcript: Array<{ id: string; role: string; text: string }>;
        status: string;
        lastError: string;
      };
      _connectError: string;
      _handleDisconnect(): void;
    };

    app._view = {
      ...app._view,
      connected: true,
      sessionId: "test-session-123",
      transcript: [{ id: "1", role: "user", text: "hello" }],
      status: "connected",
    };
    app._connectError = "some error";

    const events: Event[] = [];
    app.addEventListener("acp-disconnect", (e: Event) => {
      events.push(e);
    });

    app._handleDisconnect();

    expect(app._view.connected).toBe(false);
    expect(app._view.sessionId).toBe("");
    expect(app._view.transcript).toEqual([]);
    expect(app._view.status).toBe("idle");
    expect(app._connectError).toBe("");
    expect(events).toHaveLength(1);
    expect((events[0] as CustomEvent).bubbles).toBe(true);
    expect((events[0] as CustomEvent).composed).toBe(true);
  });
});
