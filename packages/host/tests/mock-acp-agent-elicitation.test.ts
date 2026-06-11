/**
 * Round-trip coverage for the deterministic external ACP mock fixture
 * (`tests/mock-acp-agent.cjs`) elicitation accept/decline/cancel branches.
 *
 * Regression guard for the flat `CreateElicitationResponse` shape: the ACP
 * SDK delivers the elicitation result as `{ action, content }` directly on the
 * JSON-RPC `result`, NOT nested under `result.action.*`. A prior version of
 * the mock read `result.action.action`, so every accept response collapsed to
 * the "Unexpected elicitation action: undefined" error string and the accept
 * path was effectively dead against the real SDK.
 *
 * This test acts as the ACP *client*: it spawns the mock subprocess, sends a
 * `session/prompt` that triggers an elicitation, answers the mock's
 * `elicitation/create` request with the flat response shape, then asserts the
 * mock's reply text round-trips back through the streamed agent chunks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const MOCK_AGENT = resolve(import.meta.dir, "../../../tests/mock-acp-agent.cjs");

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

type MessageListener = (msg: JsonRpcMessage) => void;

/**
 * Minimal stdio driver around the mock. Writes line-delimited JSON-RPC and
 * broadcasts every inbound line to registered listeners.
 */
class MockDriver {
  private readonly child: ChildProcessWithoutNullStreams;
  private id = 1;
  private readonly listeners = new Set<MessageListener>();

  constructor() {
    this.child = spawn("node", [MOCK_AGENT], {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      for (const listener of [...this.listeners]) listener(msg);
    });
  }

  nextId(): number {
    return this.id++;
  }

  send(msg: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  on(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolve on the first inbound message matching `match`. */
  once(match: (msg: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> {
    return new Promise((resolve) => {
      const off = this.on((msg) => {
        if (match(msg)) {
          off();
          resolve(msg);
        }
      });
    });
  }

  /** Send a request with an auto-assigned id; resolve on its reply. */
  async request(method: string, params: Record<string, unknown>): Promise<JsonRpcMessage> {
    const id = this.nextId();
    const replied = this.once((msg) => msg.id === id && msg.method === undefined);
    this.send({ jsonrpc: "2.0", id, method, params });
    return replied;
  }

  stop(): void {
    this.child.kill("SIGKILL");
  }
}

/**
 * Run one elicitation prompt end-to-end and return the joined agent text.
 *
 * `respond` is invoked with the mock's `elicitation/create` request id so the
 * caller controls the flat response payload.
 */
async function runElicitation(
  driver: MockDriver,
  promptText: string,
  respond: () => JsonRpcMessage["result"],
): Promise<string> {
  await driver.request("initialize", {});
  await driver.request("session/new", {});

  const promptId = driver.nextId();

  // The mock streams `agent_message_chunk` updates then replies to the prompt
  // id with `{ stopReason }`. Collect chunk text until that reply lands.
  const chunks: string[] = [];
  const offChunks = driver.on((msg) => {
    const update = msg.params?.update as
      | { sessionUpdate?: string; content?: { text?: string } }
      | undefined;
    if (msg.method === "session/update" && update?.sessionUpdate === "agent_message_chunk") {
      if (typeof update.content?.text === "string") chunks.push(update.content.text);
    }
  });

  // The mock emits exactly one `elicitation/create` request before it can
  // finish the prompt; answer it with the caller-controlled flat shape.
  const offElicit = driver.on((msg) => {
    if (msg.method === "elicitation/create") {
      driver.send({ jsonrpc: "2.0", id: msg.id, result: respond() });
    }
  });

  const promptReplied = driver.once(
    (msg) => msg.id === promptId && msg.result?.stopReason !== undefined,
  );
  driver.send({
    jsonrpc: "2.0",
    id: promptId,
    method: "session/prompt",
    params: { sessionId: "mock-session-123", prompt: [{ type: "text", text: promptText }] },
  });

  await promptReplied;
  offChunks();
  offElicit();
  return chunks.join("");
}

describe("mock-acp-agent.cjs elicitation", () => {
  let driver: MockDriver;

  afterEach(() => {
    if (driver) driver.stop();
  });

  test("accept branch round-trips the flat { action, content } response", async () => {
    driver = new MockDriver();
    const text = await runElicitation(driver, "browser smoke elicitation accept", () => ({
      action: "accept",
      content: { topic: "release readiness", urgent: true, priority: 3 },
    }));

    // The accept branch must read `content` off the flat result. If the mock
    // regressed to the nested `result.action.content` read, `topic` would be
    // undefined and the text would be the "Unexpected elicitation action"
    // error string instead.
    expect(text).toBe("Elicitation accepted for release readiness. Urgent=true. Priority=3.");
    expect(text).not.toContain("Unexpected elicitation action");
  }, 30_000);

  test("decline branch round-trips the flat { action } response", async () => {
    driver = new MockDriver();
    const text = await runElicitation(driver, "browser smoke elicitation decline", () => ({
      action: "decline",
    }));
    expect(text).toBe("Elicitation declined by the browser smoke fixture.");
    expect(text).not.toContain("Unexpected elicitation action");
  }, 30_000);

  test("cancel branch round-trips the flat { action } response", async () => {
    driver = new MockDriver();
    const text = await runElicitation(driver, "browser smoke elicitation cancel", () => ({
      action: "cancel",
    }));
    expect(text).toBe("Elicitation cancelled by the browser smoke fixture.");
    expect(text).not.toContain("Unexpected elicitation action");
  }, 30_000);
});
