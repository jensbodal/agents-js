import { describe, expect, test } from "bun:test";
import type { A2AClientController, A2AEvent, A2ASessionState } from "@agents-js/a2a-client";
import { createInitialSessionState } from "@agents-js/a2a-client";
import { createTestRenderer } from "@opentui/core/testing";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import {
  attachClientKeyHandlers,
  parseClientCommandArgs,
  runClientCommand,
  runOneShotMessage,
} from "../src/client/command.ts";
import { createClientHeader } from "../src/client/ui/header.ts";
import { createClientInputBar } from "../src/client/ui/input-bar.ts";
import { createClientTranscriptView } from "../src/client/ui/transcript.ts";

describe("client command", () => {
  test("parses url, headers, and flags", () => {
    const parsed = parseClientCommandArgs([
      "--url",
      "http://127.0.0.1:55363",
      "--header",
      "authorization: Bearer token",
      "--header",
      "x-foo: bar",
      "--raw",
      "--probe",
      "--no-poll",
    ]);

    expect(parsed.url).toBe("http://127.0.0.1:55363");
    expect(parsed.headers).toEqual({
      authorization: "Bearer token",
      "x-foo": "bar",
    });
    expect(parsed.raw).toBe(true);
    expect(parsed.probe).toBe(true);
    expect(parsed.poll).toBe(false);
  });

  test("--header accepts a well-formed name:value pair", () => {
    const parsed = parseClientCommandArgs(["--url", "http://x.test", "--header", "a:b"]);
    expect(parsed.headers).toEqual({ a: "b" });
  });

  test("--header rejects whitespace-only key and value", () => {
    expect(() => parseClientCommandArgs(["--url", "http://x.test", "--header", " : "])).toThrow(
      'Invalid --header value " : "',
    );
  });

  test("--header rejects whitespace-only value", () => {
    expect(() => parseClientCommandArgs(["--url", "http://x.test", "--header", "a: "])).toThrow(
      'Invalid --header value "a: "',
    );
  });

  test("--header rejects whitespace-only key", () => {
    expect(() => parseClientCommandArgs(["--url", "http://x.test", "--header", " :b"])).toThrow(
      'Invalid --header value " :b"',
    );
  });

  test("repeated --header flags accumulate into the headers map", () => {
    const parsed = parseClientCommandArgs([
      "--url",
      "http://x.test",
      "--header",
      "a:1",
      "--header",
      "b:2",
      "--header",
      "c:3",
    ]);
    expect(parsed.headers).toEqual({ a: "1", b: "2", c: "3" });
  });

  test("missing --header value surfaces as a missing-value error", () => {
    expect(() => parseClientCommandArgs(["--url", "http://x.test", "--header"])).toThrow(
      "Missing value for --header",
    );
  });

  test("unknown flag yields a client-scoped diagnostic", () => {
    expect(() => parseClientCommandArgs(["--bogus"])).toThrow(
      "[agents-js] Unknown client argument: --bogus",
    );
  });

  test("prints help without starting the app", async () => {
    let output = "";
    const exitCode = await runClientCommand(["--help"], {
      output: {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      },
      runApp: async () => {
        throw new Error("should not run app");
      },
    });

    expect(exitCode).toBe(0);
    expect(output).toMatch(/agents-js v[0-9]/);
    expect(output).toContain("— client");
    expect(output).toContain("Reuse a specific task id");
  });

  test("delegates app launch for normal client mode", async () => {
    let invoked = false;
    const exitCode = await runClientCommand(["--url", "http://127.0.0.1:55363"], {
      runApp: async (options) => {
        invoked = true;
        expect(options.target.mode).toBe("base");
        expect(options.target.url).toBe("http://127.0.0.1:55363");
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(invoked).toBe(true);
  });

  test("header component reflects controller state", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });
    const header = createClientHeader(renderer);
    const state = createInitialSessionState({
      status: "connected",
      target: {
        baseUrl: "http://127.0.0.1:55363",
        cardUrl: "http://127.0.0.1:55363/.well-known/agent-card.json",
        protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
        card: {
          name: "test-agent",
          description: "desc",
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
      },
    });

    header.update(state);

    // Status sits inside the right-cluster sub-container (header
    // refactored to group badges+status so they stay right-adjacent
    // under flex `justify-content: space-between`). Use
    // `findDescendantById` (recursive) rather than `getRenderable`
    // (direct-children only) so the lookup survives the layout change.
    const status = header.root.findDescendantById("client-header-status");
    expect(status).toBeDefined();
  });

  test("input bar surfaces rejected sends via onError + stderr, does not reject", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });
    let invoked = false;
    const errors: unknown[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    const stderrLines: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const inputBar = createClientInputBar(renderer, {
        onAuthSelection: async () => {},
        onElicitationResponse: async () => {},
        onSend: async () => {
          invoked = true;
          throw new Error("boom");
        },
        onError: (error) => {
          errors.push(error);
        },
      });

      // submit resolves — it must never reject, because the caller is the
      // opentui keypress handler which has no upstream rejection path.
      await expect(inputBar.submit("hello")).resolves.toBeUndefined();
    } finally {
      process.stderr.write = origWrite;
    }

    expect(invoked).toBe(true);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
    expect(stderrLines.some((line) => line.includes("submit callback failed: boom"))).toBe(true);
  });

  test("input bar surfaces auth-selection errors via onError", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });
    const errors: unknown[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      const inputBar = createClientInputBar(renderer, {
        onAuthSelection: async () => {
          throw new Error("auth-fail");
        },
        onElicitationResponse: async () => {},
        onSend: async () => {},
        onError: (error) => {
          errors.push(error);
        },
      });

      // Simulate an auth_required state so the submit path dispatches to
      // onAuthSelection rather than onSend.
      inputBar.update(
        createInitialSessionState({
          activeAuth: {
            authMethods: [
              {
                id: "m1",
                name: "Method 1",
              },
            ],
            message: "Authentication required",
          },
          status: "auth_required",
        }),
      );

      await expect(inputBar.submit("m1")).resolves.toBeUndefined();
    } finally {
      process.stderr.write = origWrite;
    }

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("auth-fail");
  });

  test("input bar surfaces elicitation-response errors via onError", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });
    const errors: unknown[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      const inputBar = createClientInputBar(renderer, {
        onAuthSelection: async () => {},
        onElicitationResponse: async () => {
          throw new Error("elicit-fail");
        },
        onSend: async () => {},
        onError: (error) => {
          errors.push(error);
        },
      });

      inputBar.update(
        createInitialSessionState({
          activeElicitation: {
            mode: "form",
            message: "Need details",
            requestedSchema: {
              properties: {
                project: { type: "string" },
              },
              required: ["project"],
            },
            sessionId: "session-1",
          },
        }),
      );
      await expect(inputBar.submit("alpha")).resolves.toBeUndefined();
    } finally {
      process.stderr.write = origWrite;
    }

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("elicit-fail");
  });

  test("input bar clears the rendered input immediately after enter", async () => {
    const { renderer, mockInput, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 40,
      height: 4,
    });

    let sentMessage: string | undefined;
    let resolveSend: (() => void) | undefined;
    const sendPromise = new Promise<void>((resolve) => {
      resolveSend = resolve;
    });

    const inputBar = createClientInputBar(renderer, async (message) => {
      sentMessage = message;
      await sendPromise;
    });
    renderer.root.add(inputBar.root);
    inputBar.focus();

    await renderOnce();
    await mockInput.typeText("Hello");
    await renderOnce();

    const beforeSubmit = captureCharFrame();
    expect(beforeSubmit).toContain("Hello");

    mockInput.pressEnter();
    await renderOnce();

    const afterSubmit = captureCharFrame();
    expect(sentMessage).toBe("Hello");
    expect(afterSubmit).not.toContain("Hello");

    resolveSend?.();
  });

  test("input bar resets draft state when a repeated elicitation uses the same message with a new schema", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24 });
    const responses: Array<Record<string, unknown>> = [];
    const inputBar = createClientInputBar(renderer, {
      onAuthSelection: async () => {},
      onElicitationResponse: async (response) => {
        responses.push(response as unknown as Record<string, unknown>);
      },
      onSend: async () => {},
    });

    inputBar.update(
      createInitialSessionState({
        activeElicitation: {
          mode: "form",
          message: "Need details",
          requestedSchema: {
            properties: {
              project: { type: "string" },
            },
            required: ["project"],
          },
          sessionId: "session-1",
        },
      }),
    );
    await inputBar.submit("alpha");

    inputBar.update(
      createInitialSessionState({
        activeElicitation: {
          mode: "form",
          message: "Need details",
          requestedSchema: {
            properties: {
              repo: { type: "string" },
            },
            required: ["repo"],
          },
          sessionId: "session-1",
        },
      }),
    );
    await inputBar.submit("beta");

    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual({
      action: "accept",
      content: { project: "alpha" },
    });
    expect(responses[1]).toEqual({
      action: "accept",
      content: { repo: "beta" },
    });
  });

  test("attachClientKeyHandlers cleans up listeners on repeated attach/destroy cycles", async () => {
    // Simulates restarting the client TUI N times against a shared
    // renderer. Without the `off("keypress", ...)` on destroy, listener
    // counts grow without bound. Asserts a zero delta across each
    // attach/detach cycle rather than an absolute count, because the
    // test renderer ships with its own baseline keypress listener.
    const { renderer } = await createTestRenderer({ width: 80, height: 4 });
    const baseline = renderer.keyInput.listenerCount("keypress");

    const cycles = 5;
    for (let i = 0; i < cycles; i += 1) {
      const controller = {
        resetSession: () => {},
        reportError: () => {},
      };
      const app = {
        destroy: () => {},
        nextInspectorTab: () => {},
      };

      const { detach } = attachClientKeyHandlers(renderer, controller, app);
      expect(renderer.keyInput.listenerCount("keypress")).toBe(baseline + 1);
      detach();
      expect(renderer.keyInput.listenerCount("keypress")).toBe(baseline);
    }
  });

  test("attachClientKeyHandlers detaches automatically when renderer emits destroy", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 4 });
    const baseline = renderer.keyInput.listenerCount("keypress");
    let destroyedApps = 0;
    const controller = {
      resetSession: () => {},
      reportError: () => {},
    };
    const app = {
      destroy: () => {
        destroyedApps += 1;
      },
      nextInspectorTab: () => {},
    };

    attachClientKeyHandlers(renderer, controller, app);
    expect(renderer.keyInput.listenerCount("keypress")).toBe(baseline + 1);

    // Emit the renderer's "destroy" signal without tearing down the
    // underlying object, so we can assert the cleanup path ran without
    // invalidating the test renderer.
    (renderer as unknown as { emit(event: string): void }).emit("destroy");

    expect(renderer.keyInput.listenerCount("keypress")).toBe(baseline);
    expect(destroyedApps).toBe(1);
  });

  test("attachClientKeyHandlers routes resetSession failures through reportError", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 4 });
    const reportedErrors: unknown[] = [];
    const controller = {
      resetSession: () => {
        throw new Error("reset-broke");
      },
      reportError: (err: unknown) => {
        reportedErrors.push(err);
      },
    };
    const app = {
      destroy: () => {},
      nextInspectorTab: () => {},
    };

    attachClientKeyHandlers(renderer, controller, app);

    // Synthesize a Ctrl+R keypress event.
    (renderer.keyInput as unknown as { emit(event: string, arg: unknown): void }).emit("keypress", {
      name: "r",
      ctrl: true,
      meta: false,
      shift: false,
      option: false,
      sequence: "\x12",
      number: false,
      raw: "\x12",
    });

    expect(reportedErrors).toHaveLength(1);
    expect((reportedErrors[0] as Error).message).toBe("reset-broke");
  });

  test("runOneShotMessage waits for message.completed + transcript before resolving (fast/cached path)", async () => {
    // Regression: on fast/cached responses, taskState can flip to
    // terminal with status="connected" before the agent transcript
    // entry is added. Previously runOneShotMessage resolved with empty
    // output in that case.
    const emitters: Array<(event: A2AEvent, state: A2ASessionState) => void> = [];
    const output: string[] = [];
    const writer = {
      write(chunk: string) {
        output.push(chunk);
        return true;
      },
    };

    const stubController = {
      async connect() {
        // Synchronous fast path — no wait.
      },
      subscribe(listener: (event: A2AEvent, state: A2ASessionState) => void): () => void {
        emitters.push(listener);
        return () => {
          const idx = emitters.indexOf(listener);
          if (idx >= 0) emitters.splice(idx, 1);
        };
      },
      async sendTurn() {
        // Simulate a fast/cached response: taskState flips terminal
        // before the transcript entry arrives, then message.completed
        // fires and the transcript gets populated. Previously the
        // subscriber resolved on the first callback (taskState terminal,
        // status connected, empty transcript) and wrote nothing.
        queueMicrotask(() => {
          for (const listener of [...emitters]) {
            listener(
              { type: "task.updated", task: {} as never },
              createInitialSessionState({
                status: "connected",
                taskState: "completed",
                transcript: [],
              }),
            );
          }
          for (const listener of [...emitters]) {
            listener(
              { type: "message.completed", text: "agent reply" } as A2AEvent,
              createInitialSessionState({
                status: "connected",
                taskState: "completed",
                transcript: [
                  {
                    id: "t1",
                    role: "agent",
                    text: "agent reply",
                  },
                ],
              }),
            );
          }
        });
      },
      clearTargetInput() {},
    };

    const exitCode = await runOneShotMessage(
      { url: "http://stub.test", mode: "base" },
      {
        headers: {},
        poll: false,
        probe: false,
        raw: false,
        message: "hi",
      },
      writer,
      {
        createController: () => stubController as unknown as A2AClientController,
      },
    );

    expect(exitCode).toBe(0);
    // Must capture the agent response text, not an empty output.
    expect(output.join("")).toContain("agent reply");
  });

  test("runOneShotMessage clears pending timers on error", async () => {
    const emitters: Array<(event: A2AEvent, state: A2ASessionState) => void> = [];
    const output: string[] = [];
    const writer = {
      write(chunk: string) {
        output.push(chunk);
        return true;
      },
    };

    let cleared = false;
    const stubController = {
      async connect() {},
      subscribe(listener: (event: A2AEvent, state: A2ASessionState) => void): () => void {
        emitters.push(listener);
        return () => {
          const idx = emitters.indexOf(listener);
          if (idx >= 0) emitters.splice(idx, 1);
        };
      },
      async sendTurn() {
        queueMicrotask(() => {
          for (const listener of [...emitters]) {
            listener(
              { type: "turn.started" } as A2AEvent,
              createInitialSessionState({
                status: "error",
                lastError: "mid-stream crash",
              }),
            );
          }
        });
      },
      clearTargetInput() {
        cleared = true;
      },
    };

    const exitCode = await runOneShotMessage(
      { url: "http://stub.test", mode: "base" },
      {
        headers: {},
        poll: false,
        probe: false,
        raw: false,
        message: "hi",
      },
      writer,
      {
        createController: () => stubController as unknown as A2AClientController,
      },
    );

    expect(exitCode).toBe(1);
    expect(output.join("")).toContain("mid-stream crash");
    // `finally` must clear pending timers / target input regardless of
    // how the promise resolved.
    expect(cleared).toBe(true);
  });

  test("transcript renders interruption prompts even without prior transcript entries", async () => {
    const { renderer } = await createTestRenderer({
      width: 60,
      height: 6,
    });
    const transcript = createClientTranscriptView(renderer);
    renderer.root.add(transcript.root);

    transcript.update(
      createInitialSessionState({
        activeElicitation: {
          mode: "form",
          message: "Need project details",
          requestedSchema: {
            properties: {
              project: { type: "string" },
            },
          },
          sessionId: "session-1",
        },
        status: "input_required",
      }),
    );

    const childIds = transcript.root.getChildren().map((child) => child.id);

    expect(childIds).not.toContain("client-transcript-placeholder");
    expect(childIds).toContain("client-transcript-entry-1");
  });
});
