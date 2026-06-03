import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, type Part, Role, type Task, TaskState, type TaskStatus } from "@a2a-js/sdk";
import type { ExecutionEventBus, RequestContext } from "@agents-js/a2a";
import type { A2ATransport, ResolvedAgentTarget } from "@agents-js/a2a-client";
import type { ACPSessionEvent, ACPSessionState } from "@agents-js/acp-host";
import { HostA2AExecutor } from "../src/host-executor.ts";
import { createMockTransport } from "./mock-a2a-transport.ts";

/** The `task` variant of a transport stream payload (`{ $case, value }`). */
type TaskStreamPayload = { $case: "task"; value: Task };

function textPart(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function userMessage(text: string): Message {
  return {
    messageId: "msg-1",
    role: Role.ROLE_USER,
    parts: [textPart(text)],
    taskId: "",
    contextId: "",
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function createRequestContext(
  text: string,
  ids?: { taskId?: string; contextId?: string; messageId?: string },
): RequestContext {
  return {
    taskId: ids?.taskId ?? "task-1",
    contextId: ids?.contextId ?? "ctx-1",
    userMessage: { ...userMessage(text), messageId: ids?.messageId ?? "msg-1" },
  } as RequestContext;
}

/**
 * Published events are `AgentEvent` wrappers (`{ kind, data }`). These helpers
 * unwrap them and read proto-shaped parts/state so assertions stay in plain
 * terms.
 */
function partText(part: Part | undefined): string | undefined {
  return part?.content?.$case === "text" ? part.content.value : undefined;
}

/**
 * Find a terminal event by state. A2A 1.0 forbids a second Task in the
 * task-lifecycle stream, so the normal `execute()` turn terminates with a
 * terminal `statusUpdate`, while the dispatch / task-failed paths still
 * publish a terminal `task`. Match either wrapper on `data.status.state`.
 */
function findTerminalStatus(published: unknown[], state: TaskState): TaskStatus | undefined {
  const wrapper = published.find(
    (e) =>
      ((e as { kind?: string }).kind === "task" ||
        (e as { kind?: string }).kind === "statusUpdate") &&
      (e as { data?: { status?: TaskStatus } }).data?.status?.state === state,
  ) as { data?: { status?: TaskStatus } } | undefined;
  return wrapper?.data?.status;
}

function terminalText(published: unknown[], state: TaskState): string | undefined {
  return partText(findTerminalStatus(published, state)?.message?.parts?.[0]);
}

function createEventBus() {
  const published: unknown[] = [];
  let finished = false;

  const eventBus = {
    publish(event: unknown) {
      published.push(event);
    },
    finished() {
      finished = true;
    },
    on() {},
    off() {},
    once() {},
    removeAllListeners() {},
  } as unknown as ExecutionEventBus;

  return {
    eventBus,
    published,
    get finished() {
      return finished;
    },
  };
}

/** Extract the text from the agent message in the first published Task event */
function getFailedTaskText(published: unknown[]): string | undefined {
  return terminalText(published, TaskState.TASK_STATE_FAILED);
}

describe("HostA2AExecutor", () => {
  test("reuses an existing session instead of creating a second one", async () => {
    let newSessionCalls = 0;
    let sendPromptCalls = 0;

    const controller = {
      getState() {
        return {
          status: "ready",
          sessionId: "session-1",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      async newSession() {
        newSessionCalls += 1;
        return "session-2";
      },
      async sendPrompt() {
        sendPromptCalls += 1;
      },
      async cancel() {},
    };

    const executor = new HostA2AExecutor(controller as never);
    const bus = createEventBus();

    await executor.execute(createRequestContext("hello"), bus.eventBus);

    expect(newSessionCalls).toBe(0);
    expect(sendPromptCalls).toBe(1);
    expect(bus.finished).toBe(true);
  });

  test("closed state includes lastError in failure message", async () => {
    const controller = {
      getState() {
        return {
          status: "closed",
          lastError: "process exited unexpectedly",
          sessionId: null,
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
    };

    const executor = new HostA2AExecutor(controller as never);
    const bus = createEventBus();

    await executor.execute(createRequestContext("hello"), bus.eventBus);

    expect(bus.finished).toBe(true);
    const text = getFailedTaskText(bus.published);
    expect(text).toContain("Controller is not ready");
    expect(text).toContain("process exited unexpectedly");
  });

  test("closed state without lastError shows status in failure message", async () => {
    const controller = {
      getState() {
        return {
          status: "closed",
          lastError: null,
          sessionId: null,
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
    };

    const executor = new HostA2AExecutor(controller as never);
    const bus = createEventBus();

    await executor.execute(createRequestContext("hello"), bus.eventBus);

    expect(bus.finished).toBe(true);
    const text = getFailedTaskText(bus.published);
    expect(text).toContain("Controller is not ready: closed");
  });

  test("error state attempts recovery via forceReset + newSession", async () => {
    let forceResetCalls = 0;
    let newSessionCalls = 0;
    let sendPromptCalls = 0;
    let callCount = 0;

    const controller = {
      getState() {
        callCount++;
        // First call returns error; after recovery, return ready
        if (callCount === 1) {
          return {
            status: "error",
            lastError: "connection timeout",
            sessionId: null,
            agentName: "gateway",
            agentCapabilities: null,
          };
        }
        return {
          status: "ready",
          sessionId: "session-recovered",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      forceReset() {
        forceResetCalls++;
      },
      async newSession() {
        newSessionCalls++;
        return "session-recovered";
      },
      async sendPrompt() {
        sendPromptCalls++;
      },
      async cancel() {},
    };

    const executor = new HostA2AExecutor(controller as never);
    const bus = createEventBus();

    await executor.execute(createRequestContext("hello after recovery"), bus.eventBus);

    expect(forceResetCalls).toBe(1);
    expect(newSessionCalls).toBe(1);
    expect(sendPromptCalls).toBe(1);
    expect(bus.finished).toBe(true);

    // Should NOT have a failed task -- it should have completed
    const failText = getFailedTaskText(bus.published);
    expect(failText).toBeUndefined();
  });

  test("error state reports combined error when recovery fails", async () => {
    const controller = {
      getState() {
        return {
          status: "error",
          lastError: "spawn ENOENT",
          sessionId: null,
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      forceReset() {},
      async newSession() {
        throw new Error("process is dead");
      },
      async cancel() {},
    };

    const executor = new HostA2AExecutor(controller as never);
    const bus = createEventBus();

    await executor.execute(createRequestContext("hello"), bus.eventBus);

    expect(bus.finished).toBe(true);
    const text = getFailedTaskText(bus.published);
    expect(text).toContain("Controller is not ready");
    expect(text).toContain("spawn ENOENT");
    expect(text).toContain("recovery failed");
    expect(text).toContain("process is dead");
  });

  test("prompting state is NOT treated as stuck — does not force-reset the active session", async () => {
    let forceResetCalls = 0;
    let sendPromptCalls = 0;

    const controller = {
      getState() {
        return {
          status: "prompting",
          lastError: null,
          sessionId: "session-active",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      forceReset() {
        forceResetCalls++;
      },
      async newSession() {
        return "session-active";
      },
      async sendPrompt() {
        sendPromptCalls++;
      },
      async cancel() {},
    };

    const executor = new HostA2AExecutor(controller as never);
    const bus = createEventBus();

    await executor.execute(createRequestContext("second request while prompting"), bus.eventBus);

    // The key assertion: prompting must NOT trigger forceReset
    expect(forceResetCalls).toBe(0);
    // sendPrompt should still be called (the executor proceeds normally)
    expect(sendPromptCalls).toBe(1);
    expect(bus.finished).toBe(true);

    // Should complete, not fail
    const failText = getFailedTaskText(bus.published);
    expect(failText).toBeUndefined();
  });

  test("cancelling state is treated as stuck and triggers forceReset recovery", async () => {
    let forceResetCalls = 0;
    let callCount = 0;

    const controller = {
      getState() {
        callCount++;
        if (callCount === 1) {
          return {
            status: "cancelling",
            lastError: null,
            sessionId: "session-cancelling",
            agentName: "gateway",
            agentCapabilities: null,
          };
        }
        return {
          status: "ready",
          sessionId: "session-recovered",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      forceReset() {
        forceResetCalls++;
      },
      async newSession() {
        return "session-recovered";
      },
      async sendPrompt() {},
      async cancel() {},
    };

    const executor = new HostA2AExecutor(controller as never);
    const bus = createEventBus();

    await executor.execute(createRequestContext("hello"), bus.eventBus);

    expect(forceResetCalls).toBe(1);
    expect(bus.finished).toBe(true);

    const failText = getFailedTaskText(bus.published);
    expect(failText).toBeUndefined();
  });

  test("tool-only turn (no agent_message_chunk) publishes 'Prompt completed.' fallback text", async () => {
    // Regression guard for the null-coalesce refactor (textBuffer: string | null).
    // When an ACP agent completes a turn without emitting any agent_message_chunk
    // updates (tool-only flow), textBuffer stays null and the terminal path must
    // substitute "Prompt completed." instead of publishing empty text.
    const controller = {
      getState() {
        return {
          status: "ready",
          sessionId: "session-1",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        // Never emit any events — simulates a tool-only turn that completes
        // without producing agent_message_chunk updates.
        return () => {};
      },
      async newSession() {
        return "session-1";
      },
      async sendPrompt() {
        // Returns cleanly with no chunks emitted via the subscribe callback.
      },
      async cancel() {},
    };

    const executor = new HostA2AExecutor(controller as never);
    const bus = createEventBus();

    await executor.execute(createRequestContext("do something without talking"), bus.eventBus);

    expect(bus.finished).toBe(true);

    const completed = findTerminalStatus(bus.published, TaskState.TASK_STATE_COMPLETED);
    expect(completed).toBeDefined();
    expect(getCompletedTaskText(bus.published)).toBe("Prompt completed.");
  });

  test("cancel-race publishes terminal Task with state 'canceled' on the original eventBus", async () => {
    // Regression guard: when cancelTask() races an in-flight prompt resolve,
    // the original task's eventBus must see a terminal Task with state
    // "canceled" BEFORE the stream ends. cancelTask() itself publishes on the
    // cancel-RPC bus, not the original — so this signal must come from the
    // execute() try-block's cancelled-early-return path.
    type Listener = (event: ACPSessionEvent, state: ACPSessionState) => void;
    const listeners = new Set<Listener>();
    const sendPromptGate = Promise.withResolvers<void>();
    const sendPromptEntered = Promise.withResolvers<void>();

    const state: Partial<ACPSessionState> = {
      status: "ready",
      sessionId: "session-1",
      agentName: "gateway",
      agentCapabilities: null,
    };

    const controller = {
      getState() {
        return state as ACPSessionState;
      },
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async newSession() {
        return "session-1";
      },
      async sendPrompt() {
        // Signal that we've entered sendPrompt, then block until the test
        // releases us. Gives the test time to call cancelTask() on a separate
        // eventBus while this prompt is in flight.
        sendPromptEntered.resolve();
        await sendPromptGate.promise;
      },
      async cancel() {},
    };

    const executor = new HostA2AExecutor(controller as never);
    const originalBus = createEventBus();
    const cancelBus = createEventBus();

    const executePromise = executor.execute(
      createRequestContext("start a long-running prompt"),
      originalBus.eventBus,
    );

    // Wait for sendPrompt to block, then cancel mid-flight.
    await sendPromptEntered.promise;

    await executor.cancelTask("task-1", cancelBus.eventBus);

    // Release the blocked sendPrompt so runPrompt resolves "completed" — but
    // the execute() owner must observe task.cancelled === true and publish a
    // "canceled" terminal task instead.
    sendPromptGate.resolve();
    await executePromise;

    expect(originalBus.finished).toBe(true);

    // Assert a canonical canceled terminal Task fired on the ORIGINAL event
    // bus — NOT the cancel-RPC bus.
    const canceled = findTerminalStatus(originalBus.published, TaskState.TASK_STATE_CANCELED);
    expect(canceled).toBeDefined();
    expect(canceled?.state).toBe(TaskState.TASK_STATE_CANCELED);

    // And no "completed" terminal leaked to the original bus (we canceled).
    const completed = findTerminalStatus(originalBus.published, TaskState.TASK_STATE_COMPLETED);
    expect(completed).toBeUndefined();

    // Sanity: the cancel-RPC eventBus was also finished by cancelTask().
    expect(cancelBus.finished).toBe(true);
  });

  test("routes controller chunks to the task that currently owns the prompt (B1 regression)", async () => {
    // Regression guard for the per-contextId event-routing fix. The prior
    // implementation picked the "first active task in Map insertion order" to receive controller
    // events, which was correct ONLY because the inFlightPrompt mutex
    // happened to keep activeTasks small. The current implementation tracks
    // an `owningTaskId` that is set at runPrompt start and cleared on
    // resolve — so events route to the task that actually ran the prompt,
    // not to whatever Map ordering yields.
    //
    // This test drives two sequential prompts through the same executor and
    // asserts the second prompt's chunks land on the second task's
    // textBuffer, not on the first task's (which already completed).
    type Listener = (event: ACPSessionEvent, state: ACPSessionState) => void;
    const listeners = new Set<Listener>();
    const state: Partial<ACPSessionState> = {
      status: "ready",
      sessionId: "session-1",
      agentName: "gateway",
      agentCapabilities: null,
    };

    let currentChunkText = "";
    const controller = {
      getState() {
        return state as ACPSessionState;
      },
      subscribe(listener: Listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async newSession() {
        return "session-1";
      },
      async sendPrompt() {
        // Emit a single agent_message_chunk with the current-turn's text so
        // each prompt produces an observable signal on the correct event bus.
        for (const listener of listeners) {
          listener(
            {
              type: "session_update",
              notification: {
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: currentChunkText },
                },
              },
            } as unknown as ACPSessionEvent,
            state as ACPSessionState,
          );
        }
      },
      async cancel() {},
    };

    const executor = new HostA2AExecutor(controller as never);

    // First prompt: task-1 / ctx-1 → "first-response".
    currentChunkText = "first-response";
    const firstBus = createEventBus();
    await executor.execute(
      createRequestContext("first", { taskId: "task-1", contextId: "ctx-1", messageId: "msg-1" }),
      firstBus.eventBus,
    );

    // Second prompt: task-2 / ctx-2 → "second-response". After the first
    // prompt completed, activeTasks is empty; the second prompt registers
    // task-2 and owns the prompt. The emitted chunk must land on
    // firstBus.published? No — it must land on the SECOND bus because task-2
    // is the one running sendPrompt right now.
    currentChunkText = "second-response";
    const secondBus = createEventBus();
    await executor.execute(
      createRequestContext("second", { taskId: "task-2", contextId: "ctx-2", messageId: "msg-2" }),
      secondBus.eventBus,
    );

    expect(firstBus.finished).toBe(true);
    expect(secondBus.finished).toBe(true);

    // The first bus saw "first-response" (either as a working status update
    // or in the terminal task's message text).
    const firstText = getCompletedTaskText(firstBus.published);
    expect(firstText).toBe("first-response");

    // The second bus saw "second-response" — critically, it did NOT see
    // "first-response" leaking across from the completed task-1. Under the
    // old "first task by insertion order" routing, if activeTasks had any
    // stale ordering issue, task-1's buffer would have absorbed both chunks;
    // the new owningTaskId routing guarantees clean separation.
    const secondText = getCompletedTaskText(secondBus.published);
    expect(secondText).toBe("second-response");
    expect(secondText).not.toContain("first-response");
  });
});

// -- @@dispatch test helpers --

/** Minimal controller stub — @@dispatch never checks controller state */
function createStubController() {
  return {
    getState() {
      return {
        status: "closed",
        lastError: "not started",
        sessionId: null,
        agentName: "gateway",
        agentCapabilities: null,
      };
    },
    subscribe() {
      return () => {};
    },
  };
}

/** Extract the completed task text from published events */
function getCompletedTaskText(published: unknown[]): string | undefined {
  return terminalText(published, TaskState.TASK_STATE_COMPLETED);
}

/**
 * Extract dispatch metadata from the published events. A2A 1.0 stream ordering
 * forbids a terminal Task in the lifecycle stream, so dispatch metadata rides
 * the INITIAL `task` event (the SDK preserves `task.metadata` across every
 * subsequent statusUpdate). Read it from that initial task wrapper.
 */
function getCompletedTaskMetadata(published: unknown[]): Record<string, unknown> | undefined {
  const wrapper = published.find(
    (e) =>
      (e as { kind?: string }).kind === "task" &&
      (e as { data?: Task }).data?.metadata !== undefined,
  ) as { data?: Task } | undefined;
  return wrapper?.data?.metadata as Record<string, unknown> | undefined;
}

/** Get text sent to the mock transport */
function createCapturingTransport(
  responses: Record<string, string>,
): A2ATransport & { sentTexts: string[] } {
  const base = createMockTransport(responses);
  const sentTexts: string[] = [];

  return {
    ...base,
    sentTexts,
    async sendMessage(target: ResolvedAgentTarget, params: unknown): Promise<Message> {
      const p = params as { message?: { parts?: Part[] } };
      const text = partText(p?.message?.parts?.[0]);
      if (text) sentTexts.push(text);
      return base.sendMessage(target, params as never) as Promise<Message>;
    },
  } as A2ATransport & { sentTexts: string[] };
}

describe("HostA2AExecutor.cancelTask — dispatch non-cancelable", () => {
  /**
   * Dispatch is intentionally non-cancelable for this release. The
   * cancel path must surface that explicitly: a status update with
   * `agents-js.cancelable=false` and the eventBus finished — never
   * a silent no-op.
   */
  test("publishes a non-cancelable status update for a dispatched taskId", async () => {
    const controller = {
      getState() {
        return {
          status: "ready",
          sessionId: "session-1",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      async cancel() {
        throw new Error("cancel must NOT be called for dispatch tasks");
      },
      permissionMode: "default" as const,
    };

    const executor = new HostA2AExecutor(controller as never);
    // The dispatch helper populates this map when executeDirectDispatch
    // routes through dispatchAcp. Seed it directly here so we exercise
    // cancelTask in isolation without standing up the full dispatch
    // pipeline (mock ACP child + ephemeral controller).
    const internals = executor as unknown as { dispatchedTaskIds: Map<string, string> };
    internals.dispatchedTaskIds.set("dispatch-task-1", "ctx-1");

    const bus = createEventBus();
    await executor.cancelTask("dispatch-task-1", bus.eventBus);

    expect(bus.finished).toBe(true);
    const wrapper = bus.published.find((e) => (e as { kind?: string }).kind === "statusUpdate") as
      | {
          data?: {
            metadata?: { "agents-js.cancelable"?: boolean };
            status?: { message?: Message };
          };
        }
      | undefined;
    const statusUpdate = wrapper?.data;
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate?.metadata?.["agents-js.cancelable"]).toBe(false);
    const text = partText(statusUpdate?.status?.message?.parts?.[0]);
    expect(text).toContain("Cancel rejected");
    expect(text).toContain("@@dispatch");
    expect(text).toContain("non-cancelable");
  });

  test("does NOT call controller.cancel() for a dispatched taskId", async () => {
    let cancelCalls = 0;
    const controller = {
      getState() {
        return {
          status: "ready",
          sessionId: "session-1",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      async cancel() {
        cancelCalls += 1;
      },
      permissionMode: "default" as const,
    };

    const executor = new HostA2AExecutor(controller as never);
    const internals = executor as unknown as { dispatchedTaskIds: Map<string, string> };
    internals.dispatchedTaskIds.set("dispatch-task-2", "ctx-2");

    const bus = createEventBus();
    await executor.cancelTask("dispatch-task-2", bus.eventBus);

    expect(cancelCalls).toBe(0);
  });

  test("falls through to the lane/primary cancel for non-dispatch taskIds", async () => {
    let cancelCalls = 0;
    const controller = {
      getState() {
        return {
          status: "ready",
          sessionId: "session-1",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      async cancel() {
        cancelCalls += 1;
      },
      permissionMode: "default" as const,
    };

    const executor = new HostA2AExecutor(controller as never);
    const bus = createEventBus();
    await executor.cancelTask("regular-task-1", bus.eventBus);

    // Non-dispatch task path goes through controller.cancel() (the
    // primary controller, since no lane is registered for this id).
    expect(cancelCalls).toBe(1);
    expect(bus.finished).toBe(true);
  });
});

describe("@@dispatch", () => {
  test("routes @@my-agent do something to target, returns response text", async () => {
    const transport = createMockTransport({
      "http://localhost:3000": "Hello from my-agent!",
    });
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: {
        "my-agent": { kind: "a2a", name: "my-agent", url: "http://localhost:3000" },
      },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@my-agent do something"), bus.eventBus);

    expect(bus.finished).toBe(true);
    const text = getCompletedTaskText(bus.published);
    expect(text).toBe("Hello from my-agent!");
  });

  test("fails with Unknown agent message for unregistered agent, lists available", async () => {
    const transport = createMockTransport({});
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: {
        alpha: { kind: "a2a", name: "alpha", url: "http://localhost:3001" },
        beta: { kind: "a2a", name: "beta", url: "http://localhost:3002" },
      },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@unknown-agent hello"), bus.eventBus);

    expect(bus.finished).toBe(true);
    const text = getFailedTaskText(bus.published);
    expect(text).toContain('Unknown agent "unknown-agent"');
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });

  test("reloads the disk registry between @@dispatch executions", async () => {
    const transport = createMockTransport({
      "http://localhost:3000": "Hello from repaired registry!",
    });
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchTransport: transport,
    });
    const tempDir = await mkdtemp(join(tmpdir(), "dispatch-registry-"));
    const configPath = join(tempDir, "registry.json");
    const previousRegistryPath = process.env.AGENTS_JS_REGISTRY;

    process.env.AGENTS_JS_REGISTRY = configPath;

    try {
      const firstBus = createEventBus();
      await executor.execute(createRequestContext("@@my-agent hello"), firstBus.eventBus);
      expect(firstBus.finished).toBe(true);
      expect(getFailedTaskText(firstBus.published)).toContain('Unknown agent "my-agent"');

      await writeFile(
        configPath,
        JSON.stringify({
          agents: { "my-agent": { kind: "a2a", url: "http://localhost:3000" } },
        }),
      );

      const secondBus = createEventBus();
      await executor.execute(createRequestContext("@@my-agent hello"), secondBus.eventBus);
      expect(secondBus.finished).toBe(true);
      expect(getCompletedTaskText(secondBus.published)).toBe("Hello from repaired registry!");
    } finally {
      if (previousRegistryPath === undefined) {
        delete process.env.AGENTS_JS_REGISTRY;
      } else {
        process.env.AGENTS_JS_REGISTRY = previousRegistryPath;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("extracts payload correctly — @@my-agent please summarize sends 'please summarize'", async () => {
    const transport = createCapturingTransport({
      "http://localhost:3000": "summary done",
    });
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: {
        "my-agent": { kind: "a2a", name: "my-agent", url: "http://localhost:3000" },
      },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@my-agent please summarize"), bus.eventBus);

    expect(bus.finished).toBe(true);
    expect(transport.sentTexts).toHaveLength(1);
    expect(transport.sentTexts[0]).toBe("please summarize");
  });

  test("handles empty payload — @@my-agent with nothing after sends '(no message)'", async () => {
    const transport = createCapturingTransport({
      "http://localhost:3000": "ack",
    });
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: {
        "my-agent": { kind: "a2a", name: "my-agent", url: "http://localhost:3000" },
      },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@my-agent"), bus.eventBus);

    expect(bus.finished).toBe(true);
    expect(transport.sentTexts).toHaveLength(1);
    expect(transport.sentTexts[0]).toBe("(no message)");
  });

  test("does not interfere with normal messages (no @@)", async () => {
    let sendPromptCalls = 0;
    const controller = {
      getState() {
        return {
          status: "ready",
          sessionId: "session-1",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      async newSession() {
        return "session-1";
      },
      async sendPrompt() {
        sendPromptCalls++;
      },
      async cancel() {},
    };

    const transport = createMockTransport({});
    const executor = new HostA2AExecutor(controller as never, {
      dispatchRegistry: {
        "my-agent": { kind: "a2a", name: "my-agent", url: "http://localhost:3000" },
      },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("hello world"), bus.eventBus);

    expect(sendPromptCalls).toBe(1);
    expect(bus.finished).toBe(true);
  });

  test("does not match @@ mid-sentence", async () => {
    let sendPromptCalls = 0;
    const controller = {
      getState() {
        return {
          status: "ready",
          sessionId: "session-1",
          agentName: "gateway",
          agentCapabilities: null,
        };
      },
      subscribe() {
        return () => {};
      },
      async newSession() {
        return "session-1";
      },
      async sendPrompt() {
        sendPromptCalls++;
      },
      async cancel() {},
    };

    const transport = createMockTransport({});
    const executor = new HostA2AExecutor(controller as never, {
      dispatchRegistry: { agent: { kind: "a2a", name: "agent", url: "http://localhost:3000" } },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("please talk to @@agent about this"), bus.eventBus);

    // Should go through normal controller path, not dispatch
    expect(sendPromptCalls).toBe(1);
    expect(bus.finished).toBe(true);
  });

  test("handles transport failure gracefully", async () => {
    const transport = createMockTransport({});
    // Override resolveTarget to throw
    transport.resolveTarget = async () => {
      throw new Error("Connection refused");
    };

    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: {
        "my-agent": { kind: "a2a", name: "my-agent", url: "http://localhost:9999" },
      },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    // Suppress console.error for the expected error
    const originalError = console.error;
    console.error = () => {};
    try {
      await executor.execute(createRequestContext("@@my-agent hello"), bus.eventBus);
    } finally {
      console.error = originalError;
    }

    expect(bus.finished).toBe(true);
    const text = getFailedTaskText(bus.published);
    expect(text).toContain("Dispatch to");
    expect(text).toContain("my-agent");
    expect(text).toContain("Connection refused");
  });

  test("does not check controller state for @@ dispatch (works even if controller is closed)", async () => {
    const transport = createMockTransport({
      "http://localhost:3000": "response despite closed controller",
    });
    // createStubController returns status: "closed" by default
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: {
        "my-agent": { kind: "a2a", name: "my-agent", url: "http://localhost:3000" },
      },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@my-agent test"), bus.eventBus);

    expect(bus.finished).toBe(true);
    // Should succeed, not fail with "Controller is not ready"
    const failText = getFailedTaskText(bus.published);
    expect(failText).toBeUndefined();
    const completedText = getCompletedTaskText(bus.published);
    expect(completedText).toBe("response despite closed controller");
  });

  test("includes agents-js.dispatch metadata in completed task", async () => {
    const transport = createMockTransport({
      "http://localhost:3000": "metadata test response",
    });
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: {
        "my-agent": { kind: "a2a", name: "my-agent", url: "http://localhost:3000" },
      },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@my-agent check metadata"), bus.eventBus);

    expect(bus.finished).toBe(true);
    const metadata = getCompletedTaskMetadata(bus.published);
    expect(metadata).toBeDefined();
    const dispatch = metadata?.["agents-js.dispatch"] as {
      agentName: string;
      agentUrl: string;
      directive: string;
    };
    expect(dispatch).toBeDefined();
    expect(dispatch.agentName).toBe("my-agent");
    expect(dispatch.agentUrl).toBe("http://localhost:3000");
    expect(dispatch.directive).toBe("@@my-agent");
  });

  // ACP-kind dispatch is now a live path (commit "feat(gateway): ACP-kind
  // dispatch via ephemeral controller"). Integration coverage lives in
  // `tests/host-executor-acp-dispatch.test.ts` where a real gateway test-server
  // + mock ACP agent fixture exercises spawn/teardown/chunk-streaming. The
  // former "not yet routable" unit test was removed as its assertion (stub
  // error text) no longer describes the behavior under test.
});

/**
 * AJS-92: host-executor A2A dispatch streams by default when the target
 * advertises `capabilities.streaming`. Mirrors the @mention middleware
 * change in `packages/a2a-client/src/middleware.ts`.
 */
describe("@@dispatch streaming-by-default (AJS-92)", () => {
  function createInstrumentedDispatchTransport(opts: {
    supportsStreaming: boolean;
    streamItems?: TaskStreamPayload[];
    streamYieldDelayMs?: number;
    messageResponseText?: string;
  }) {
    const calls: string[] = [];
    const transport: A2ATransport = {
      async resolveTarget(input) {
        const target: ResolvedAgentTarget = {
          baseUrl: input.url,
          cardUrl: `${input.url}/.well-known/agent.json`,
          card: {
            name: "mock-agent",
            description: "mock",
            supportedInterfaces: [
              { url: input.url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1" },
            ],
            version: "1.0.0",
            skills: [],
            defaultInputModes: ["text"],
            defaultOutputModes: ["text"],
            capabilities: { extensions: [], streaming: opts.supportsStreaming },
            provider: undefined,
            securitySchemes: {},
            securityRequirements: [],
            signatures: [],
          },
          protocolVersion: "0.3.0",
          capabilities: {
            inputModes: ["text"],
            outputModes: ["text"],
            supportsTextInput: true,
            supportsTextOutput: true,
            supportsStreaming: opts.supportsStreaming,
            supportsPushNotifications: false,
            raw: { extensions: [], streaming: opts.supportsStreaming },
          },
        };
        return target;
      },
      async inspectTarget() {
        return { status: "ready" };
      },
      async sendMessage(): Promise<Message> {
        calls.push("sendMessage");
        return {
          messageId: crypto.randomUUID(),
          role: Role.ROLE_AGENT,
          parts: [textPart(opts.messageResponseText ?? "non-streaming")],
          taskId: "",
          contextId: "",
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        } satisfies Message;
      },
      async *sendMessageStream() {
        calls.push("sendMessageStream");
        for (const item of opts.streamItems ?? []) {
          if (opts.streamYieldDelayMs && opts.streamYieldDelayMs > 0) {
            await new Promise((r) => setTimeout(r, opts.streamYieldDelayMs));
          }
          yield item;
        }
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
      async deleteTaskPushNotificationConfig() {},
      async getExtendedAgentCard() {
        throw new Error("Not implemented");
      },
      async probe() {
        return [];
      },
      subscribeDebug() {
        return () => {};
      },
    } as A2ATransport;
    return { transport, calls };
  }

  function streamingTaskItems(text: string): TaskStreamPayload[] {
    const working: Task = {
      id: "task-1",
      contextId: "ctx-1",
      status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
      artifacts: [],
      history: [],
      metadata: undefined,
    };
    const completed: Task = {
      id: "task-1",
      contextId: "ctx-1",
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
      artifacts: [],
      history: [
        {
          messageId: "msg-1",
          role: Role.ROLE_AGENT,
          parts: [textPart(text)],
          taskId: "",
          contextId: "",
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
      ],
      metadata: undefined,
    };
    return [
      { $case: "task", value: working },
      { $case: "task", value: completed },
    ];
  }

  test("uses streaming dispatch when the target advertises streaming", async () => {
    const { transport, calls } = createInstrumentedDispatchTransport({
      supportsStreaming: true,
      streamItems: streamingTaskItems("streamed terminal reply"),
    });
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: { agent: { kind: "a2a", name: "agent", url: "http://localhost:3000" } },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@agent hello"), bus.eventBus);

    expect(bus.finished).toBe(true);
    expect(calls).toEqual(["sendMessageStream"]);
    expect(getCompletedTaskText(bus.published)).toBe("streamed terminal reply");
  });

  test("falls back to non-streaming dispatch when the target lacks streaming", async () => {
    const { transport, calls } = createInstrumentedDispatchTransport({
      supportsStreaming: false,
      messageResponseText: "non-streaming reply",
    });
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: { agent: { kind: "a2a", name: "agent", url: "http://localhost:3000" } },
      dispatchTransport: transport,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@agent hello"), bus.eventBus);

    expect(bus.finished).toBe(true);
    expect(calls).toEqual(["sendMessage"]);
    expect(getCompletedTaskText(bus.published)).toBe("non-streaming reply");
  });

  test("explicit dispatchStream: false forces non-streaming even when target advertises streaming", async () => {
    const { transport, calls } = createInstrumentedDispatchTransport({
      supportsStreaming: true,
      // Intentionally empty stream items: if streaming silently leaked in,
      // the empty stream would fail the dispatch.
      streamItems: [],
      messageResponseText: "forced non-streaming",
    });
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: { agent: { kind: "a2a", name: "agent", url: "http://localhost:3000" } },
      dispatchTransport: transport,
      dispatchStream: false,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@agent hello"), bus.eventBus);

    expect(bus.finished).toBe(true);
    expect(calls).toEqual(["sendMessage"]);
    expect(getCompletedTaskText(bus.published)).toBe("forced non-streaming");
  });

  test("emits dispatch-streaming-long-running audit warning when a streaming dispatch exceeds threshold", async () => {
    const { createAuditEmitter } = await import("@agents-js/a2a/audit");
    const audit = createAuditEmitter({ logger: { log: () => {} } });
    const { transport } = createInstrumentedDispatchTransport({
      supportsStreaming: true,
      streamItems: streamingTaskItems("eventual reply"),
      streamYieldDelayMs: 60,
    });
    const executor = new HostA2AExecutor(createStubController() as never, {
      dispatchRegistry: { slow: { kind: "a2a", name: "slow", url: "http://localhost:3000" } },
      dispatchTransport: transport,
      dispatchStreamingLongWarnMs: 30,
      audit,
    });
    const bus = createEventBus();

    await executor.execute(createRequestContext("@@slow please"), bus.eventBus);

    expect(bus.finished).toBe(true);
    const warned = audit.recent().filter((e) => e.kind === "dispatch-streaming-long-running");
    expect(warned.length).toBe(1);
    const event = warned[0] as Extract<
      ReturnType<typeof audit.recent>[number],
      { kind: "dispatch-streaming-long-running" }
    >;
    expect(event.thresholdMs).toBe(30);
    expect(event.resumptionAvailable).toBe(false);
    expect(event.harness).toBe("a2a");
    expect(event.kindVariant).toBe("a2a");
  });
});
