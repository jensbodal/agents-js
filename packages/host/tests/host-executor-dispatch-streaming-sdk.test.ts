/**
 * Durable regression test for `@@dispatch` over the A2A 1.0 STREAMING path,
 * driven through the REAL SDK `DefaultRequestHandler` / `ResultManager` (via
 * `UniversalA2AServer`'s `SendStreamingMessage` SSE endpoint) — not a mock
 * event bus.
 *
 * Why this exists: the migration's `executeDirectDispatch` originally emitted a
 * `statusUpdate` before any initial Task and terminated with a Task mid-stream
 * — both illegal on the streaming path. The SDK's `ResultManager` rejects those
 * ("received task in task lifecycle stream" / "statusUpdate before initial
 * Message/Task"), but the existing host/executor tests use a mock bus and never
 * exercise the real handler's streaming path, so the bug was caught late. This
 * test locks the ordering invariants against the real handler.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { AgentRegistryMap } from "../src/agent-registry.ts";
import { createGatewayTestServer, type GatewayTestServerHandle } from "../src/testing.ts";

const MOCK_AGENT = resolve(import.meta.dir, "../../../tests/mock-acp-agent.cjs");

function acpRegistryEntry(name: string): AgentRegistryMap {
  return {
    [name]: { kind: "acp", name, harness: "mock", command: "node", args: [MOCK_AGENT] },
  };
}

interface StatusLike {
  state?: string;
  message?: { parts?: { text?: string }[] };
}
/**
 * A2A 1.0 stream frame: a JSON-RPC envelope whose `result` is a `StreamResponse`
 * — proto-JSON serializes its oneof as the field name (`task` / `statusUpdate` /
 * `message` / `artifactUpdate`), not a `$case` wrapper.
 */
interface StreamFrame {
  jsonrpc: string;
  id: string;
  result?: {
    task?: { status?: StatusLike };
    statusUpdate?: { status?: StatusLike };
    message?: unknown;
    artifactUpdate?: unknown;
  };
  error?: { code: number; message: string };
}

function frameKind(frame: StreamFrame): string {
  const result = frame.result ?? {};
  if (result.task) return "task";
  if (result.statusUpdate) return "statusUpdate";
  if (result.message) return "message";
  if (result.artifactUpdate) return "artifactUpdate";
  return "unknown";
}

const TERMINAL_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

/** POST `SendStreamingMessage` and collect every SSE `data:` frame. */
async function collectStream(url: string, text: string): Promise<StreamFrame[]> {
  const response = await fetch(`${url}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "SendStreamingMessage",
      params: {
        tenant: "",
        message: {
          messageId: crypto.randomUUID(),
          role: "ROLE_USER",
          parts: [{ text, mediaType: "text/plain" }],
        },
        configuration: {},
      },
    }),
  });
  expect((response.headers.get("content-type") ?? "").startsWith("text/event-stream")).toBe(true);
  const body = await response.text();
  return body
    .split("\n\n")
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("data: ")),
    )
    .filter((line): line is string => !!line)
    .map((line) => JSON.parse(line.slice("data: ".length)) as StreamFrame);
}

describe("HostA2AExecutor — @@dispatch streaming ordering (real ResultManager)", () => {
  let handle: GatewayTestServerHandle;

  afterEach(async () => {
    if (handle) {
      await handle.stop();
    }
  });

  test("a @@dispatch turn streams a valid A2A 1.0 lifecycle through the real handler", async () => {
    handle = await createGatewayTestServer({
      acpCommand: "node",
      acpArgs: [MOCK_AGENT],
      dispatchRegistry: acpRegistryEntry("acp-agent"),
    });

    const frames = await collectStream(handle.url, "@@acp-agent hello");

    // No JSON-RPC error frame: a stream-ordering violation in the dispatch path
    // surfaces as the SDK ResultManager throwing, which errors the stream.
    expect(frames.every((frame) => !frame.error)).toBe(true);
    expect(frames.length).toBeGreaterThan(0);

    const kinds = frames.map(frameKind);
    const firstFrame = frames.at(0);
    const lastFrame = frames.at(-1);

    // Invariant 1: the lifecycle opens with exactly one Task in SUBMITTED.
    expect(kinds.at(0)).toBe("task");
    expect(firstFrame?.result?.task?.status?.state).toBe("TASK_STATE_SUBMITTED");

    // Invariant 2: NO second Task after the lifecycle is established — the
    // "received task in task lifecycle stream" violation that bit @@dispatch.
    expect(kinds.filter((kind) => kind === "task").length).toBe(1);

    // Invariant 3: the turn terminates with a terminal *statusUpdate* (never a
    // terminal Task mid-stream), carrying the dispatched agent's reply.
    expect(kinds.at(-1)).toBe("statusUpdate");
    const lastStatus = lastFrame?.result?.statusUpdate?.status;
    expect(TERMINAL_STATES.has(lastStatus?.state ?? "")).toBe(true);
    expect(lastStatus?.message?.parts?.[0]?.text ?? "").toContain("Mock ACP Agent");
  }, 30_000);
});
