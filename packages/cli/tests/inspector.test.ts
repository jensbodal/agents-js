import { describe, expect, test } from "bun:test";
import type { DebugRecord, ResolvedAgentTarget } from "@agents-js/a2a-client";
import { createInitialSessionState } from "@agents-js/a2a-client";
import { createTestRenderer } from "@opentui/core/testing";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import { createClientInspector } from "../src/client/ui/inspector.ts";

function makeTarget(overrides: Partial<ResolvedAgentTarget> = {}): ResolvedAgentTarget {
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
    ...overrides,
  };
}

function makeDebugRecord(overrides: Partial<DebugRecord> = {}): DebugRecord {
  return {
    requestId: "req-1",
    timestamp: new Date().toISOString(),
    direction: "outbound",
    kind: "http",
    method: "POST",
    url: "http://127.0.0.1:55363",
    headers: {},
    ...overrides,
  };
}

describe("inspector", () => {
  describe("tab cycling", () => {
    test("starts on the card tab", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 60,
        height: 12,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({ target: makeTarget() });
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain("Inspector: card");
    });

    test("cycles card -> session -> debug -> card", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 60,
        height: 12,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({ target: makeTarget() });

      inspector.nextTab();
      inspector.update(state);
      await renderOnce();
      expect(captureCharFrame()).toContain("Inspector: session");

      inspector.nextTab();
      inspector.update(state);
      await renderOnce();
      expect(captureCharFrame()).toContain("Inspector: debug");

      inspector.nextTab();
      inspector.update(state);
      await renderOnce();
      expect(captureCharFrame()).toContain("Inspector: card");
    });
  });

  describe("formatCard", () => {
    test("shows 'No connected target' when target is undefined", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 60,
        height: 12,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      inspector.update(createInitialSessionState());
      await renderOnce();

      expect(captureCharFrame()).toContain("No connected target");
    });

    test("shows formatted card summary when not in raw mode", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 60,
        height: 12,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({
        target: makeTarget({
          capabilities: {
            inputModes: ["text", "image"],
            outputModes: ["text"],
            supportsTextInput: true,
            supportsTextOutput: true,
            supportsStreaming: true,
            supportsPushNotifications: false,
            raw: {},
          },
        }),
      });
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain("name: test-agent");
      expect(frame).toContain("url: http://127.0.0.1:55363");
      expect(frame).toContain(`protocol: ${CURRENT_A2A_PROTOCOL_VERSION}`);
      expect(frame).toContain("input modes: text, image");
      expect(frame).toContain("streaming: yes");
    });

    test("shows raw JSON when in raw mode", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 80,
        height: 20,
      });
      const inspector = createClientInspector(renderer, true);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({ target: makeTarget() });
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain('"name": "test-agent"');
      expect(frame).toContain('"version": "1.0.0"');
    });
  });

  describe("formatSession", () => {
    test("shows session details with all fields", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 60,
        height: 16,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({
        target: makeTarget(),
        status: "waiting",
        contextId: "ctx-123",
        taskId: "task-456",
        transcript: [
          { id: "1", role: "user", text: "hello" },
          { id: "2", role: "agent", text: "hi" },
        ],
        pendingAgentText: "thinking...",
      });

      inspector.nextTab(); // switch to session
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain("status: waiting");
      expect(frame).toContain("context: ctx-123");
      expect(frame).toContain("task: task-456");
      expect(frame).toContain("messages: 2");
      expect(frame).toContain("pending: yes");
    });

    test("shows error when lastError is set", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 60,
        height: 16,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({
        target: makeTarget(),
        status: "error",
        lastError: "Connection refused",
      });

      inspector.nextTab();
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain("error: Connection refused");
    });

    test("shows dash for absent optional fields", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 60,
        height: 16,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({
        target: makeTarget(),
        status: "idle",
      });

      inspector.nextTab();
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain("context: -");
      expect(frame).toContain("task: -");
      expect(frame).toContain("pending: no");
    });
  });

  describe("formatDebug", () => {
    test("shows 'No debug records yet' when empty", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 60,
        height: 12,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({
        target: makeTarget(),
        debugRecords: [],
      });

      inspector.nextTab(); // session
      inspector.nextTab(); // debug
      inspector.update(state);
      await renderOnce();

      expect(captureCharFrame()).toContain("No debug records yet");
    });

    test("shows formatted debug records in non-raw mode", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 80,
        height: 16,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({
        target: makeTarget(),
        debugRecords: [
          makeDebugRecord({
            direction: "outbound",
            kind: "http",
            method: "POST",
            url: "/message/send",
            status: 200,
          }),
          makeDebugRecord({
            direction: "inbound",
            kind: "http",
            method: "GET",
            url: "/tasks/abc",
            status: 404,
          }),
        ],
      });

      inspector.nextTab(); // session
      inspector.nextTab(); // debug
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain("outbound");
      expect(frame).toContain("POST");
      expect(frame).toContain("/message/send");
      expect(frame).toContain("inbound");
      expect(frame).toContain("GET");
    });

    test("shows client kind records with body text", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 80,
        height: 16,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const state = createInitialSessionState({
        target: makeTarget(),
        debugRecords: [
          makeDebugRecord({
            kind: "client",
            method: "sendTurn",
            url: "http://localhost",
            body: "hello world",
          }),
        ],
      });

      inspector.nextTab();
      inspector.nextTab();
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain("sendTurn");
      expect(frame).toContain("hello world");
    });

    test("shows raw JSON in raw mode", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 80,
        height: 20,
      });
      const inspector = createClientInspector(renderer, true);
      renderer.root.add(inspector.root);

      const record = makeDebugRecord({
        direction: "outbound",
        method: "POST",
        url: "/message/send",
        status: 200,
      });
      const state = createInitialSessionState({
        target: makeTarget(),
        debugRecords: [record],
      });

      inspector.nextTab();
      inspector.nextTab();
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      expect(frame).toContain('"method": "POST"');
      expect(frame).toContain('"url": "/message/send"');
    });

    test("only shows last 8 records", async () => {
      const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
        width: 80,
        height: 30,
      });
      const inspector = createClientInspector(renderer, false);
      renderer.root.add(inspector.root);

      const records: DebugRecord[] = [];
      for (let i = 0; i < 12; i++) {
        records.push(
          makeDebugRecord({
            requestId: `req-${i}`,
            url: `/endpoint-${i}`,
            method: "GET",
          }),
        );
      }
      const state = createInitialSessionState({
        target: makeTarget(),
        debugRecords: records,
      });

      inspector.nextTab();
      inspector.nextTab();
      inspector.update(state);
      await renderOnce();

      const frame = captureCharFrame();
      // First 4 should be sliced off (12 - 8 = 4)
      expect(frame).not.toContain("/endpoint-0");
      expect(frame).not.toContain("/endpoint-3");
      // Last 8 should be visible
      expect(frame).toContain("/endpoint-4");
      expect(frame).toContain("/endpoint-11");
    });
  });
});
