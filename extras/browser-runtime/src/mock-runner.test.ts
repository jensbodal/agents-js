import { describe, expect, test } from "bun:test";
import type { JsonRpcMessage } from "./browser-acp-shim.ts";
import { createMockRunner } from "./mock-runner.ts";

type NotificationParams = { sessionId: string; kind: string; text?: string; tool?: string };

function paramsOf(msg: JsonRpcMessage): NotificationParams | undefined {
  if (!("method" in msg)) return undefined;
  return (msg as { params?: NotificationParams }).params;
}

describe("createMockRunner", () => {
  test("emits a tool.invoked then a stream of answer.chunks and resolves", async () => {
    const runner = createMockRunner({ chunkIntervalMs: 0 });
    const events: JsonRpcMessage[] = [];

    await runner.runPrompt({ sessionId: "s1", input: "hi" }, (m) => events.push(m));

    const kinds = events.map((e) => paramsOf(e)?.kind);
    expect(kinds[0]).toBe("tool.invoked");
    expect(kinds.slice(1).every((k) => k === "answer.chunk")).toBe(true);
    expect(kinds[kinds.length - 1]).toBe("answer.chunk");
    expect(kinds.length).toBeGreaterThan(2);
  });

  test("every emitted message preserves the sessionId", async () => {
    const runner = createMockRunner({ chunkIntervalMs: 0 });
    const events: JsonRpcMessage[] = [];

    await runner.runPrompt({ sessionId: "abc-123", input: "anything" }, (m) => events.push(m));

    for (const ev of events) {
      expect(paramsOf(ev)?.sessionId).toBe("abc-123");
    }
  });

  test("answer chunks concatenate to a non-empty user-readable string", async () => {
    const runner = createMockRunner({ chunkIntervalMs: 0 });
    const events: JsonRpcMessage[] = [];

    await runner.runPrompt({ sessionId: "s1", input: "hi" }, (m) => events.push(m));

    const answer = events
      .map((e) => paramsOf(e))
      .filter((p) => p?.kind === "answer.chunk")
      .map((p) => p?.text ?? "")
      .join("");

    expect(answer.length).toBeGreaterThan(20);
    expect(answer).toContain("mocked");
  });
});
