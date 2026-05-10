import { describe, expect, test } from "bun:test";
import type {
  A2AEvent,
  A2ASessionState,
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
} from "@agents-js/a2a-client";
import { A2AClientController, A2AClientProvider } from "@agents-js/a2a-client";
import { createTestRenderer } from "@opentui/core/testing";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import { createClientApp } from "../src/client/ui/app.ts";

function makeTarget(): ResolvedAgentTarget {
  return {
    baseUrl: "http://127.0.0.1:55363",
    cardUrl: "http://127.0.0.1:55363/.well-known/agent-card.json",
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    card: {
      name: "test-agent",
      description: "A test agent",
      url: "http://127.0.0.1:55363",
      version: "1.0.0",
      protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      capabilities: {},
    },
    capabilities: {
      inputModes: ["text"],
      outputModes: ["text"],
      supportsTextInput: true,
      supportsTextOutput: true,
      supportsStreaming: false,
      supportsPushNotifications: false,
      raw: {},
    },
  };
}

function createStubTransport(): A2ATransport {
  return {
    async resolveTarget(_input: AgentTargetInput): Promise<ResolvedAgentTarget> {
      return makeTarget();
    },
    async inspectTarget() {
      throw new Error("Not implemented");
    },
    async sendMessage() {
      throw new Error("Not implemented");
    },
    sendMessageStream() {
      throw new Error("Not implemented");
    },
    async getTask() {
      throw new Error("Not implemented");
    },
    async cancelTask() {
      throw new Error("Not implemented");
    },
    resubscribeTask() {
      throw new Error("Not implemented");
    },
    async setTaskPushNotificationConfig() {
      throw new Error("Not implemented");
    },
    async getTaskPushNotificationConfig() {
      throw new Error("Not implemented");
    },
    async listTaskPushNotificationConfigs() {
      throw new Error("Not implemented");
    },
    async deleteTaskPushNotificationConfig() {
      throw new Error("Not implemented");
    },
    async getExtendedAgentCard() {
      throw new Error("Not implemented");
    },
    async probe() {
      return [];
    },
    subscribeDebug() {
      return () => {};
    },
  };
}

describe("app", () => {
  test("composes header, body (transcript + inspector), and input bar", async () => {
    const { renderer } = await createTestRenderer({ width: 100, height: 24 });
    const provider = new A2AClientProvider(createStubTransport());
    const controller = new A2AClientController({
      initialState: { target: makeTarget(), status: "connected" },
      provider,
    });

    const app = createClientApp(renderer, controller, { poll: true, raw: false });

    // The root should have been added to renderer.root
    const clientRoot = renderer.root.findDescendantById("client-root");
    expect(clientRoot).not.toBeUndefined();

    // Verify the tree structure: header, body, active-action, input-bar
    const rootChildren = clientRoot?.getChildren() ?? [];
    expect(rootChildren.length).toBe(4);
    expect(rootChildren[0]?.id).toBe("client-header-root");
    expect(rootChildren[1]?.id).toBe("client-body");
    expect(rootChildren[2]?.id).toBe("client-active-action-root");
    // The input bar root on main is an InputRenderable (no id set), so check it exists
    expect(rootChildren[3]).not.toBeUndefined();

    // Body should contain transcript and inspector
    const bodyChildren = rootChildren[1]?.getChildren() ?? [];
    expect(bodyChildren.length).toBe(2);
    expect(bodyChildren[0]?.id).toBe("client-transcript-root");
    expect(bodyChildren[1]?.id).toBe("client-inspector-root");

    app.destroy();
  });

  test("start() propagates initial state to all components", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 100,
      height: 24,
    });
    const provider = new A2AClientProvider(createStubTransport());
    const controller = new A2AClientController({
      initialState: { target: makeTarget(), status: "connected" },
      provider,
    });

    const app = createClientApp(renderer, controller, { poll: true, raw: false });
    app.start();
    await renderOnce();

    const frame = captureCharFrame();
    // Header should show the agent name
    expect(frame).toContain("test-agent");
    // Header should show connected status
    expect(frame).toContain("[connected]");
    // Inspector should show card info
    expect(frame).toContain("Inspector: card");

    app.destroy();
  });

  test("controller subscription forwards state updates to UI", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 100,
      height: 24,
    });
    const provider = new A2AClientProvider(createStubTransport());
    const controller = new A2AClientController({
      initialState: { target: makeTarget(), status: "connected" },
      provider,
    });

    const app = createClientApp(renderer, controller, { poll: true, raw: false });
    app.start();
    await renderOnce();

    // Simulate a state change via resetSession (which emits session.updated)
    controller.resetSession();
    await renderOnce();

    // After reset, status should be "connected" (since target remains)
    const frame = captureCharFrame();
    expect(frame).toContain("[connected]");

    app.destroy();
  });

  test("destroy() unsubscribes from controller", async () => {
    const { renderer } = await createTestRenderer({ width: 100, height: 24 });
    const provider = new A2AClientProvider(createStubTransport());
    const controller = new A2AClientController({
      initialState: { target: makeTarget(), status: "connected" },
      provider,
    });

    // Track how many times the subscription callback fires
    let updateCount = 0;
    const originalSubscribe = controller.subscribe.bind(controller);
    controller.subscribe = (listener: (event: A2AEvent, state: A2ASessionState) => void) => {
      const wrappedListener = (event: A2AEvent, state: A2ASessionState) => {
        updateCount++;
        listener(event, state);
      };
      return originalSubscribe(wrappedListener);
    };

    const app = createClientApp(renderer, controller, { poll: true, raw: false });
    app.start();

    // Trigger a state change to confirm subscription is active
    controller.resetSession();
    const countAfterReset = updateCount;
    expect(countAfterReset).toBeGreaterThan(0);

    // Destroy the app
    app.destroy();

    // Trigger another state change
    controller.resetSession();
    // The count should not have increased because destroy unsubscribed
    expect(updateCount).toBe(countAfterReset);
  });

  test("nextInspectorTab() cycles the inspector tab", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 100,
      height: 24,
    });
    const provider = new A2AClientProvider(createStubTransport());
    const controller = new A2AClientController({
      initialState: { target: makeTarget(), status: "connected" },
      provider,
    });

    const app = createClientApp(renderer, controller, { poll: true, raw: false });
    app.start();
    await renderOnce();

    expect(captureCharFrame()).toContain("Inspector: card");

    app.nextInspectorTab();
    await renderOnce();
    expect(captureCharFrame()).toContain("Inspector: session");

    app.nextInspectorTab();
    await renderOnce();
    expect(captureCharFrame()).toContain("Inspector: debug");

    app.nextInspectorTab();
    await renderOnce();
    expect(captureCharFrame()).toContain("Inspector: card");

    app.destroy();
  });
});
