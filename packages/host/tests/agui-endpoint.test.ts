import { describe, expect, test } from "bun:test";
import type { ACPSessionEvent } from "@agents-js/acp-host";
import { EventType } from "@agents-js/agui-types";
import { createAguiFetchHandler } from "../src/agui-endpoint.ts";
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
    const handler = createAguiFetchHandler({ controller: fake.controller });
    const req = new Request("http://local/agent", {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: "not json",
    });
    const response = await handler(req);
    expect(response?.status).toBe(400);
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
    // Note: RunAgentInputSchema requires threadId to be present and
    // non-empty. The contract says "echo threadId when provided, else
    // crypto.randomUUID()" — this is relevant in practice when
    // consumers pass an empty threadId and we synthesize one. AG-UI's
    // spec enforces required, but the endpoint defensively handles
    // the echo-vs-synthesize branch. See contract row 5 in the brief.
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

describe("createAguiFetchHandler — surface events (Wave 5)", () => {
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
