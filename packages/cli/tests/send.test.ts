import { describe, expect, test } from "bun:test";
import type {
  A2AClientController,
  A2AEvent,
  A2ASessionState,
  AgentTargetInput,
} from "@agents-js/a2a-client";
import { createInitialSessionState } from "@agents-js/a2a-client";
import type { AgentRegistryRecord } from "@agents-js/a2a-client/node";
import { parseSendCommandArgs, runSendCommand } from "../src/send.ts";

interface RecordingWriter {
  readonly value: string;
  write(chunk: string): boolean;
}

function makeWriter(): RecordingWriter {
  let content = "";
  return {
    get value() {
      return content;
    },
    write(chunk: string) {
      content += chunk;
      return true;
    },
  };
}

interface StubControllerCall {
  message: string;
  metadata?: Record<string, unknown>;
}

interface StubControllerOptions {
  connectImpl?: () => Promise<void>;
  sendTurnImpl?: (
    message: string,
    emit: (event: A2AEvent, state: A2ASessionState) => void,
  ) => Promise<void>;
}

function makeStubController(options: StubControllerOptions = {}): {
  controller: A2AClientController;
  calls: StubControllerCall[];
  cleared: boolean;
  connectTargets: AgentTargetInput[];
} {
  const emitters: Array<(event: A2AEvent, state: A2ASessionState) => void> = [];
  const calls: StubControllerCall[] = [];
  const connectTargets: AgentTargetInput[] = [];
  let cleared = false;

  const controller = {
    async connect(target: AgentTargetInput) {
      connectTargets.push(target);
      if (options.connectImpl) {
        await options.connectImpl();
      }
    },
    subscribe(listener: (event: A2AEvent, state: A2ASessionState) => void): () => void {
      emitters.push(listener);
      return () => {
        const idx = emitters.indexOf(listener);
        if (idx >= 0) emitters.splice(idx, 1);
      };
    },
    async sendTurn(message: string, opts?: { metadata?: Record<string, unknown> }) {
      calls.push({ message, metadata: opts?.metadata });
      if (options.sendTurnImpl) {
        await options.sendTurnImpl(message, (event, state) => {
          for (const listener of [...emitters]) {
            listener(event, state);
          }
        });
      }
    },
    clearTargetInput() {
      cleared = true;
    },
  } as unknown as A2AClientController;

  // Expose helpers on the return value (controller is an opaque object
  // to the consumer; `calls`, `connectTargets`, and `cleared` are the
  // inspection surface).
  return {
    controller,
    calls,
    connectTargets,
    get cleared() {
      return cleared;
    },
  } as {
    controller: A2AClientController;
    calls: StubControllerCall[];
    connectTargets: AgentTargetInput[];
    cleared: boolean;
  };
}

function makeRecord(partial: Partial<AgentRegistryRecord> & { name: string }): AgentRegistryRecord {
  return {
    name: partial.name,
    agent_id: partial.agent_id ?? `gw.${partial.name}`,
    kind: partial.kind ?? "a2a",
    gateway_id: partial.gateway_id ?? "gw",
    source: partial.source ?? "manual",
    registered_at: partial.registered_at ?? "2026-05-01T00:00:00.000Z",
    ...(partial.url !== undefined ? { url: partial.url } : {}),
    ...(partial.harness !== undefined ? { harness: partial.harness } : {}),
  };
}

describe("parseSendCommandArgs", () => {
  test("parses --url and positional message", () => {
    const parsed = parseSendCommandArgs(["--url", "http://127.0.0.1:55363", "what", "is", "2+2?"]);
    expect(parsed.url).toBe("http://127.0.0.1:55363");
    expect(parsed.message).toBe("what is 2+2?");
    expect(parsed.raw).toBe(false);
  });

  test("parses --harness and --raw", () => {
    const parsed = parseSendCommandArgs([
      "--url",
      "http://x.test",
      "--harness",
      "claude",
      "--raw",
      "hello",
    ]);
    expect(parsed.harness).toBe("claude");
    expect(parsed.raw).toBe(true);
    expect(parsed.message).toBe("hello");
  });

  test("parses --help / -h", () => {
    expect(parseSendCommandArgs(["--help"]).help).toBe(true);
    expect(parseSendCommandArgs(["-h"]).help).toBe(true);
  });

  test("throws on unknown flag with send-scoped diagnostic", () => {
    expect(() => parseSendCommandArgs(["--bogus", "hi"])).toThrow(
      "[agents-js] Unknown send argument: --bogus",
    );
  });

  test("throws when --url is missing its value", () => {
    expect(() => parseSendCommandArgs(["--url"])).toThrow("Missing value for --url");
  });

  test("joins multiple positional tokens into the message", () => {
    const parsed = parseSendCommandArgs(["--url", "http://x.test", "foo", "bar", "baz"]);
    expect(parsed.message).toBe("foo bar baz");
  });
});

describe("runSendCommand — help + validation", () => {
  test("prints help and exits 0", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const exitCode = await runSendCommand(["--help"], {
      stdout,
      stderr,
      env: {},
    });
    expect(exitCode).toBe(0);
    expect(stdout.value).toMatch(/agents-js v[0-9]/);
    expect(stdout.value).toContain("— send");
    expect(stdout.value).toContain("AGENTS_JS_SERVE_URL");
  });

  test("returns 1 when message is missing", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const exitCode = await runSendCommand(["--url", "http://127.0.0.1:55363"], {
      stdout,
      stderr,
      env: {},
    });
    expect(exitCode).toBe(1);
    expect(stderr.value).toContain("Missing message");
  });

  test("returns 1 when --url and AGENTS_JS_SERVE_URL are both absent", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const exitCode = await runSendCommand(["hello"], {
      stdout,
      stderr,
      env: {},
    });
    expect(exitCode).toBe(1);
    expect(stderr.value).toContain("Missing --url");
    expect(stderr.value).toContain("AGENTS_JS_SERVE_URL");
  });

  test("falls back to AGENTS_JS_SERVE_URL when --url is omitted", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const { controller, calls } = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "message.completed", text: "ok" } as A2AEvent,
            createInitialSessionState({
              status: "connected",
              taskState: "completed",
              transcript: [{ id: "t1", role: "agent", text: "ok" }],
            }),
          );
        });
      },
    });

    const exitCode = await runSendCommand(["hello"], {
      stdout,
      stderr,
      env: { AGENTS_JS_SERVE_URL: "http://env-default.test" },
      createController: () => controller,
    });

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("hello");
  });

  test("returns 1 on unknown flag and writes diagnostic to stderr", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const exitCode = await runSendCommand(["--bogus", "hi"], {
      stdout,
      stderr,
      env: {},
    });
    expect(exitCode).toBe(1);
    expect(stderr.value).toContain("Unknown send argument: --bogus");
  });
});

describe("runSendCommand — dispatch + happy path", () => {
  test("happy path: sends message, prints agent reply, exits 0", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const { controller, calls } = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "message.completed", text: "agent reply" } as A2AEvent,
            createInitialSessionState({
              status: "connected",
              taskState: "completed",
              transcript: [{ id: "t1", role: "agent", text: "agent reply" }],
            }),
          );
        });
      },
    });

    const exitCode = await runSendCommand(
      ["--url", "http://127.0.0.1:55363", "what", "is", "2+2?"],
      {
        stdout,
        stderr,
        env: {},
        createController: () => controller,
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.value).toContain("agent reply");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("what is 2+2?");
    expect(calls[0]?.metadata).toBeUndefined();
  });

  test("threads --harness into sendTurn metadata", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const { controller, calls } = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "message.completed", text: "done" } as A2AEvent,
            createInitialSessionState({
              status: "connected",
              taskState: "completed",
              transcript: [{ id: "t1", role: "agent", text: "done" }],
            }),
          );
        });
      },
    });

    const exitCode = await runSendCommand(
      ["--url", "http://x.test", "--harness", "claude", "fix this"],
      {
        stdout,
        stderr,
        env: {},
        createController: () => controller,
      },
    );

    expect(exitCode).toBe(0);
    expect(calls[0]?.metadata).toEqual({ harness: "claude" });
  });

  test("--raw streams message.delta chunks to stdout and appends a trailing newline", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const { controller } = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "message.delta", text: "hello" } as A2AEvent,
            createInitialSessionState({ status: "sending" }),
          );
          emit(
            { type: "message.delta", text: "hello world", delta: " world" } as A2AEvent,
            createInitialSessionState({ status: "sending" }),
          );
          emit(
            { type: "message.completed", text: "hello world" } as A2AEvent,
            createInitialSessionState({
              status: "connected",
              taskState: "completed",
              transcript: [{ id: "t1", role: "agent", text: "hello world" }],
            }),
          );
        });
      },
    });

    const exitCode = await runSendCommand(["--url", "http://x.test", "--raw", "hi"], {
      stdout,
      stderr,
      env: {},
      createController: () => controller,
    });

    expect(exitCode).toBe(0);
    // First delta drains via the accumulated-text suffix path; second
    // delta uses the explicit `delta` field.
    expect(stdout.value).toBe("hello world\n");
  });
});

describe("runSendCommand — error + elicitation paths", () => {
  test("returns 1 on transport connect failure", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const { controller } = makeStubController({
      connectImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const exitCode = await runSendCommand(["--url", "http://x.test", "hi"], {
      stdout,
      stderr,
      env: {},
      createController: () => controller,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toContain("Failed to connect");
    expect(stderr.value).toContain("ECONNREFUSED");
  });

  test("returns 1 on mid-stream controller error event", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const { controller } = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "turn.started" } as A2AEvent,
            createInitialSessionState({
              status: "error",
              lastError: "gateway crashed",
            }),
          );
        });
      },
    });

    const exitCode = await runSendCommand(["--url", "http://x.test", "hi"], {
      stdout,
      stderr,
      env: {},
      createController: () => controller,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toContain("gateway crashed");
  });

  test("returns 2 when agent requests elicitation", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const { controller } = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "turn.started" } as A2AEvent,
            createInitialSessionState({
              status: "input_required",
              activeElicitation: {
                mode: "form",
                message: "Need details",
                requestedSchema: {
                  properties: { project: { type: "string" } },
                  required: ["project"],
                },
                sessionId: "session-1",
              },
            }),
          );
        });
      },
    });

    const exitCode = await runSendCommand(["--url", "http://x.test", "hi"], {
      stdout,
      stderr,
      env: {},
      createController: () => controller,
    });

    // EXIT_AUTH_REQUIRED (71) — non-interactive elicitation requires
    // the user to switch to `agents-js client`.
    expect(exitCode).toBe(71);
    expect(stderr.value).toContain("Agent requested elicitation");
    expect(stderr.value).toContain("agents-js client");
  });

  test("returns 2 when agent requests authentication", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const { controller } = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "turn.started" } as A2AEvent,
            createInitialSessionState({
              status: "auth_required",
              activeAuth: {
                authMethods: [{ id: "m1", name: "Method 1" }],
                message: "Authentication required",
              },
            }),
          );
        });
      },
    });

    const exitCode = await runSendCommand(["--url", "http://x.test", "hi"], {
      stdout,
      stderr,
      env: {},
      createController: () => controller,
    });

    // EXIT_AUTH_REQUIRED (71) — non-interactive auth requires the user
    // to switch to `agents-js client`.
    expect(exitCode).toBe(71);
    expect(stderr.value).toContain("Agent requested authentication");
  });

  test("clears controller target input after completion", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const stub = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "message.completed", text: "ok" } as A2AEvent,
            createInitialSessionState({
              status: "connected",
              taskState: "completed",
              transcript: [{ id: "t1", role: "agent", text: "ok" }],
            }),
          );
        });
      },
    });

    await runSendCommand(["--url", "http://x.test", "hi"], {
      stdout,
      stderr,
      env: {},
      createController: () => stub.controller,
    });

    expect(stub.cleared).toBe(true);
  });

  test("--harness routes to the matching registry record's URL", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const stub = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "message.completed", text: "ok" } as A2AEvent,
            createInitialSessionState({
              status: "connected",
              taskState: "completed",
              transcript: [{ id: "t1", role: "agent", text: "ok" }],
            }),
          );
        });
      },
    });

    const records: AgentRegistryRecord[] = [
      makeRecord({ name: "noise", url: "http://nope.test" }),
      makeRecord({ name: "claude-gw", url: "http://claude.test", harness: "claude" }),
    ];

    const exitCode = await runSendCommand(["--harness", "claude", "hello"], {
      stdout,
      stderr,
      env: {},
      createController: () => stub.controller,
      loadRegistryRecords: async () => records,
    });

    expect(exitCode).toBe(0);
    expect(stub.connectTargets[0]?.url).toBe("http://claude.test");
    // metadata.harness still threaded through.
    expect(stub.calls[0]?.metadata).toEqual({ harness: "claude" });
  });

  test("--harness with no matching entry returns 1 and prints a usage error", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const exitCode = await runSendCommand(["--harness", "missing", "hello"], {
      stdout,
      stderr,
      env: {},
      loadRegistryRecords: async () => [],
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toContain('No registered agent with harness="missing"');
    expect(stderr.value).toContain("agents-js registry add");
    expect(stderr.value).toContain("--url");
  });

  test("--harness ignores acp-only records (no URL) and reports the miss", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const records: AgentRegistryRecord[] = [
      makeRecord({ name: "claude-acp", kind: "acp", harness: "claude" }),
    ];

    const exitCode = await runSendCommand(["--harness", "claude", "hello"], {
      stdout,
      stderr,
      env: {},
      loadRegistryRecords: async () => records,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toContain('No registered agent with harness="claude"');
  });

  test("--url overrides --harness without consulting the registry", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const stub = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "message.completed", text: "ok" } as A2AEvent,
            createInitialSessionState({
              status: "connected",
              taskState: "completed",
              transcript: [{ id: "t1", role: "agent", text: "ok" }],
            }),
          );
        });
      },
    });
    let registryCalled = false;

    const exitCode = await runSendCommand(
      ["--url", "http://explicit.test", "--harness", "claude", "hello"],
      {
        stdout,
        stderr,
        env: {},
        createController: () => stub.controller,
        loadRegistryRecords: async () => {
          registryCalled = true;
          return [];
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(registryCalled).toBe(false);
    expect(stub.connectTargets[0]?.url).toBe("http://explicit.test");
    expect(stub.calls[0]?.metadata).toEqual({ harness: "claude" });
  });

  test("--harness does NOT fall back to AGENTS_JS_SERVE_URL on miss", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const exitCode = await runSendCommand(["--harness", "missing", "hello"], {
      stdout,
      stderr,
      env: { AGENTS_JS_SERVE_URL: "http://env-default.test" },
      loadRegistryRecords: async () => [],
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toContain("No registered agent with harness");
  });

  test("clears controller target input even on error", async () => {
    const stdout = makeWriter();
    const stderr = makeWriter();
    const stub = makeStubController({
      sendTurnImpl: async (_message, emit) => {
        queueMicrotask(() => {
          emit(
            { type: "turn.started" } as A2AEvent,
            createInitialSessionState({
              status: "error",
              lastError: "boom",
            }),
          );
        });
      },
    });

    await runSendCommand(["--url", "http://x.test", "hi"], {
      stdout,
      stderr,
      env: {},
      createController: () => stub.controller,
    });

    expect(stub.cleared).toBe(true);
  });
});
