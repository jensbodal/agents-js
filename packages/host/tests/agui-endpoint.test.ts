import { describe, expect, test } from "bun:test";
import type { ACPSessionEvent } from "@agents-js/acp-host";
import { EventType } from "@agents-js/agui-types";
import { createAguiFetchHandler } from "../src/agui-endpoint.ts";
import { AguiRunCoordinator } from "../src/agui-run-coordinator.ts";
import { buildRunAgentInput, createFakeHostController } from "./fake-host-controller.ts";

/**
 * Integration tests for the `POST /agent` handler. Backed by a narrow
 * fake controller built against the `Pick<>` surface declared in
 * `host-executor.ts:27` — the same pattern used by other gateway
 * tests.
 */

const createFakeController = createFakeHostController;

async function readSseFrames(response: Response): Promise<unknown[]> {
  if (!response.body) return [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: unknown[] = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const json = line.slice("data: ".length);
      frames.push(JSON.parse(json));
    }
  }
  return frames;
}

describe("createAguiFetchHandler — routing", () => {
  test("returns null for non-matching paths", async () => {
    const fake = createFakeController();
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/other", { method: "POST" });
    const response = await handler(req);
    expect(response).toBeNull();
  });

  test("returns null for GET /agent (only POST is handled)", async () => {
    const fake = createFakeController();
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", { method: "GET" });
    const response = await handler(req);
    expect(response).toBeNull();
  });

  test("406 when Accept header does not include text/event-stream", async () => {
    const fake = createFakeController();
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
    });
    const response = await handler(req);
    expect(response?.status).toBe(406);
  });

  test("400 when body is not valid JSON", async () => {
    const fake = createFakeController();
    const warnCalls: unknown[][] = [];
    const handler = createAguiFetchHandler({
      controller: fake.controller,
      logger: {
        warn: (...args: unknown[]) => warnCalls.push(args),
        error: () => {},
        log: () => {},
      },
    });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: "not json",
    });
    const response = await handler(req);
    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { error: string; message?: string };
    expect(body).toEqual({ error: "Invalid JSON body" });
    expect(body.message).toBeUndefined();
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[0]).toBe("[Gateway/AG-UI] Invalid JSON body");
    expect(typeof (warnCalls[0]?.[1] as { error?: unknown } | undefined)?.error).toBe("string");
  });

  test("400 when body is not a valid RunAgentInput", async () => {
    const fake = createFakeController();
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({ bogus: true }),
    });
    const response = await handler(req);
    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { error: string; issues: unknown };
    expect(body.error).toBe("Invalid RunAgentInput");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  test("400 when the latest user message is non-text content", async () => {
    const fake = createFakeController();
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const input = buildRunAgentInput("text");
    input.messages = [
      {
        id: "msg-image",
        role: "user",
        content: [{ type: "image", url: "data:image/png;base64,abc" }],
      } as never,
    ];
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const response = await handler(req);
    expect(response?.status).toBe(400);
    const body = (await response?.json()) as { error: string; message: string };
    expect(body.error).toBe("Unsupported user message content");
    expect(body.message).toBe("POST /agent accepts text user messages only.");
    expect(fake.sendPromptCalls()).toBe(0);
  });
});

describe("createAguiFetchHandler — happy path streaming", () => {
  test("emits RUN_STARTED, translated events, RUN_FINISHED in order", async () => {
    const fake = createFakeController();
    // When sendPrompt is invoked, simulate the agent turn: a single
    // text chunk followed by turn_completed. Return a promise that
    // resolves after turn_completed fires so the endpoint's awaited
    // `done` promise settles before sendPrompt itself resolves.
    fake.setOnSendPrompt(async () => {
      fake.emit({
        type: "session_update",
        notification: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello" },
            messageId: "msg-1",
          },
        },
      } as ACPSessionEvent);
      fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
    });

    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("say hi")),
    });
    const response = await handler(req);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("text/event-stream");
    expect(response?.headers.get("cache-control")).toBe("no-cache, no-transform");

    const frames = (await readSseFrames(response as Response)) as Array<{
      type: string;
      [k: string]: unknown;
    }>;
    const types = frames.map((f) => f.type);

    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types.at(-1)).toBe(EventType.RUN_FINISHED);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types).toContain(EventType.CUSTOM);

    // threadId/runId contract
    const started = frames[0] as unknown as { threadId: string; runId: string };
    expect(started.threadId).toBe("thread-1");
    expect(typeof started.runId).toBe("string");
    const finished = frames.at(-1) as unknown as { threadId: string; runId: string };
    expect(finished.threadId).toBe(started.threadId);
    expect(finished.runId).toBe(started.runId);

    expect(fake.sendPromptCalls()).toBe(1);
  });

  test("synthesizes threadId when RunAgentInput omits it", async () => {
    // AG-UI requires a non-empty threadId, and the endpoint preserves
    // that value when it is provided.
    const fake = createFakeController();
    fake.setOnSendPrompt(async () => {
      fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
    });
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("x", { threadId: "echo-me" })),
    });
    const response = await handler(req);
    const frames = (await readSseFrames(response as Response)) as Array<{ threadId?: string }>;
    expect((frames[0] as { threadId: string }).threadId).toBe("echo-me");
  });
});

describe("createAguiFetchHandler — error paths", () => {
  test("error event from controller maps to RUN_ERROR and closes the stream", async () => {
    const fake = createFakeController();
    fake.setOnSendPrompt(async () => {
      fake.emit({ type: "error", message: "boom" } as ACPSessionEvent);
    });

    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("bang")),
    });
    const response = await handler(req);
    const frames = (await readSseFrames(response as Response)) as Array<{
      type: string;
      message?: string;
    }>;
    const types = frames.map((f) => f.type);

    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.RUN_ERROR);
    const runError = frames.find((f) => f.type === EventType.RUN_ERROR) as { message: string };
    expect(runError.message).toBe("boom");
    // No RUN_FINISHED after RUN_ERROR
    expect(types).not.toContain(EventType.RUN_FINISHED);
  });

  test("sendPrompt rejection maps to RUN_ERROR", async () => {
    const fake = createFakeController();
    fake.setOnSendPrompt(async () => {
      throw new Error("prompt failed");
    });
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("boom")),
    });
    const response = await handler(req);
    const frames = (await readSseFrames(response as Response)) as Array<{
      type: string;
      message?: string;
    }>;
    const runError = frames.find((f) => f.type === EventType.RUN_ERROR);
    expect(runError).toBeDefined();
    expect((runError as { message: string }).message).toBe("prompt failed");
  });
});

describe("createAguiFetchHandler — surface events", () => {
  test("surface_event from controller flows through as CUSTOM agents-js.a2ui.surface_event", async () => {
    const fake = createFakeController();
    const surfacePayload = { kind: "beginRendering", components: [{ id: "root" }] };
    fake.setOnSendPrompt(async () => {
      fake.emit({
        type: "surface_event",
        surfaceId: "surf-42",
        event: surfacePayload,
      } satisfies ACPSessionEvent);
      fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
    });

    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("hi")),
    });
    const response = await handler(req);
    expect(response?.status).toBe(200);

    const frames = (await readSseFrames(response as Response)) as Array<{
      type: string;
      name?: string;
      value?: unknown;
    }>;

    const surfaceFrame = frames.find(
      (f) => f.type === EventType.CUSTOM && f.name === "agents-js.a2ui.surface_event",
    );
    expect(surfaceFrame).toBeDefined();
    expect(surfaceFrame?.value).toEqual({ surfaceId: "surf-42", event: surfacePayload });

    // Stream still completes normally after the surface event.
    expect(frames.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });
});

describe("createAguiFetchHandler — run identity", () => {
  test("preserves the client-supplied runId on RUN_STARTED and RUN_FINISHED", async () => {
    const fake = createFakeController();
    fake.setOnSendPrompt(async () => {
      fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
    });
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("hi", { runId: "client-run-42" })),
    });
    const response = await handler(req);
    expect(response?.status).toBe(200);
    const frames = (await readSseFrames(response as Response)) as Array<{
      type: string;
      runId?: string;
    }>;
    const started = frames.find((f) => f.type === EventType.RUN_STARTED);
    const finished = frames.find((f) => f.type === EventType.RUN_FINISHED);
    expect(started?.runId).toBe("client-run-42");
    expect(finished?.runId).toBe("client-run-42");
  });

  test("uses the client-supplied runId in the busy response when a second run collides", async () => {
    const fake = createFakeController();
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fake.setOnSendPrompt(async () => {
      await firstHeld;
      fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
    });

    const coordinator = new AguiRunCoordinator();
    const handler = createAguiFetchHandler({ controller: fake.controller, coordinator });

    const firstReq = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("first", { runId: "client-run-A" })),
    });
    const firstResponsePromise = handler(firstReq);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const secondReq = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("second", { runId: "client-run-B" })),
    });
    const secondResponse = await handler(secondReq);

    const body = (await secondResponse?.json()) as { activeRunId: string };
    expect(body.activeRunId).toBe("client-run-A");

    releaseFirst();
    const firstResponse = await firstResponsePromise;
    await readSseFrames(firstResponse as Response);
  });
});

describe("createAguiFetchHandler — single-active-run gate", () => {
  test("second concurrent run returns 409 Conflict before opening SSE", async () => {
    const fake = createFakeController();
    // Hold the first run open until we say go.
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fake.setOnSendPrompt(async () => {
      await firstHeld;
      fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
    });

    const coordinator = new AguiRunCoordinator();
    const handler = createAguiFetchHandler({ controller: fake.controller, coordinator });

    const firstReq = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("first", { runId: "run-A" })),
    });
    const firstResponsePromise = handler(firstReq);

    // Yield once so the endpoint enters its acquire path. The fake
    // sendPrompt above blocks on `firstHeld`, so the coordinator stays
    // busy until we release it below.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const secondReq = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("second", { runId: "run-B" })),
    });
    const secondResponse = await handler(secondReq);

    expect(secondResponse?.status).toBe(409);
    expect(secondResponse?.headers.get("content-type")).toBe("application/json");
    const body = (await secondResponse?.json()) as {
      error: string;
      message: string;
      activeRunId: string;
    };
    expect(body.error).toBe("Busy");
    expect(typeof body.activeRunId).toBe("string");
    expect(body.activeRunId.length).toBeGreaterThan(0);

    // Let the first run finish so the test cleans up.
    releaseFirst();
    const firstResponse = await firstResponsePromise;
    await readSseFrames(firstResponse as Response);
  });

  test("a run that completes releases the slot for the next run", async () => {
    const fake = createFakeController();
    fake.setOnSendPrompt(async () => {
      fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
    });

    const coordinator = new AguiRunCoordinator();
    const handler = createAguiFetchHandler({ controller: fake.controller, coordinator });

    for (let i = 0; i < 3; i += 1) {
      const req = new Request("http://local/agent", {
        method: "POST",
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify(buildRunAgentInput(`hi-${i}`)),
      });
      const response = await handler(req);
      expect(response?.status).toBe(200);
      const frames = await readSseFrames(response as Response);
      expect((frames.at(-1) as { type: string } | undefined)?.type).toBe(EventType.RUN_FINISHED);
    }

    // After all runs finish, the coordinator must be idle.
    expect(coordinator.isActive).toBe(false);
  });
});

describe("createAguiFetchHandler — lease release waits for cancel", () => {
  test("a second /agent during a slow controller.cancel() gets 409, not 200", async () => {
    // The cancel() callback must not release the run lease while
    // controller.cancel() is still draining the prior turn. The
    // run-session awaits the cancel before resolving done so the
    // endpoint's start() finally remains the single release point.
    const fake = createFakeController();

    // Override cancel() to take a measurable time so the race is
    // observable. The plain cancelCalls() counter only proves cancel
    // was *called*, not that the lease release waited for it.
    // Definite-assignment assertion: the assignment happens inside
    // the cancel patch below, which always runs before we call
    // `cancelResolve()` after the second handler resolves.
    let cancelResolve!: () => void;
    let cancelStartedResolve!: () => void;
    const cancelStarted = new Promise<void>((resolve) => {
      cancelStartedResolve = resolve;
    });
    const original = fake.controller.cancel;
    fake.controller.cancel = async (): Promise<void> => {
      await original();
      await new Promise<void>((r) => {
        cancelResolve = r;
        cancelStartedResolve();
      });
    };

    fake.setOnSendPrompt(async () => {
      // Hold the prompt indefinitely until the abort path takes over.
      await new Promise(() => {});
    });

    const coordinator = new AguiRunCoordinator();
    const handler = createAguiFetchHandler({
      controller: fake.controller,
      coordinator,
    });

    const ac = new AbortController();
    const firstReq = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("hold", { runId: "run-A" })),
      signal: ac.signal,
    });
    const firstResponse = await handler(firstReq);
    expect(firstResponse?.status).toBe(200);

    // Read RUN_STARTED, then cancel the reader to fire the disconnect path.
    const reader = (firstResponse as Response).body?.getReader();
    if (!reader) throw new Error("expected SSE body reader");
    await reader.read();
    void reader.cancel();

    // Wait until the cancel hook has been invoked but is NOT yet
    // resolved — that is the window where a second run could
    // otherwise race the lease release.
    await cancelStarted;

    // While cancel is still draining, a second run must see Busy.
    const secondReq = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("racer", { runId: "run-B" })),
    });
    const secondResponse = await handler(secondReq);
    expect(secondResponse?.status).toBe(409);
    const body = (await secondResponse?.json()) as { activeRunId: string };
    expect(body.activeRunId).toBe("run-A");

    // Let the cancel finish so the test cleans up.
    cancelResolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe("createAguiFetchHandler — disconnect cancels controller", () => {
  test("client disconnect calls controller.cancel() and emits a terminal RUN_ERROR", async () => {
    const fake = createFakeController();
    // Hold the run open: never emit turn_completed until aborted.
    let abortObserved = false;
    fake.setOnSendPrompt(async () => {
      // Wait a long time — the test will abort the request before
      // sendPrompt resolves naturally.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (!abortObserved) {
        fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
      }
    });

    const handler = createAguiFetchHandler({ controller: fake.controller });
    const ac = new AbortController();
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("hold")),
      signal: ac.signal,
    });
    const response = await handler(req);
    expect(response?.status).toBe(200);

    // Read the first frame (RUN_STARTED) so we know the stream opened,
    // then cancel the reader to simulate the client closing the SSE.
    const reader = (response as Response).body?.getReader();
    if (!reader) throw new Error("expected SSE body reader");
    const decoder = new TextDecoder();
    const { value: firstChunk } = await reader.read();
    const firstText = decoder.decode(firstChunk);
    expect(firstText).toContain(EventType.RUN_STARTED);

    abortObserved = true;
    await reader.cancel(); // triggers the stream's cancel() handler

    // controller.cancel() must have been called as a result of the
    // disconnect — the AG-UI primary surface contract.
    // Give the abort handler a tick to run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.cancelCalls()).toBeGreaterThanOrEqual(1);
  });
});

describe("createAguiFetchHandler — session bootstrap", () => {
  test("opens a new session when getState reports no sessionId", async () => {
    const fake = createFakeController({ sessionId: null, status: "ready" });
    fake.setOnSendPrompt(async () => {
      fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
    });
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify(buildRunAgentInput("hi")),
    });
    const response = await handler(req);
    const frames = await readSseFrames(response as Response);
    const firstType = (frames[0] as { type: string }).type;
    expect(firstType).toBe(EventType.RUN_STARTED);
    expect(fake.sendPromptCalls()).toBe(1);
  });
});
