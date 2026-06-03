import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  ACPtoA2AExecutor,
  buildAgentCard,
  CURRENT_A2A_PROTOCOL_VERSION,
  UniversalA2AServer,
} from "@agents-js/a2a";
import { spawnACPAgent } from "@agents-js/acp";

const gatewayCard = buildAgentCard({
  name: "e2e-test-gateway",
  description: "Testing full protocol bridge",
  capabilities: { "text-to-text": {} },
});

const validationCard = buildAgentCard({
  name: "e2e-test-gateway",
  description: "Testing validation path",
  capabilities: { "text-to-text": {} },
});

const parseErrorCard = buildAgentCard({
  name: "e2e-test-gateway",
  description: "Testing parse error path",
  capabilities: { "text-to-text": {} },
});

// A2A 1.0 moved the transport URL into `supportedInterfaces[].url`. To prove
// the gateway preserves a caller-supplied URL across `start()`, the URL must
// be set on a non-sentinel `supportedInterfaces[0].url`: `finalizeDefaultUrl`
// only overwrites the placeholder sentinel (`http://127.0.0.1`), so a custom
// interface URL survives the bound-port rewrite untouched. (Passing a
// top-level `url` to `buildAgentCard` no longer works — it lands as a junk
// top-level field while the sentinel interface still gets overwritten.)
const customUrlCard = buildAgentCard({
  name: "e2e-test-gateway",
  description: "Testing custom URL preservation",
  supportedInterfaces: [
    {
      url: "https://gateway.example.test",
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    },
  ],
  capabilities: { "text-to-text": {} },
});

/**
 * A2A 1.0 builds the request `message` from protobuf-canonical JSON: parts
 * carry `{ text }` (no `kind`), roles are `"ROLE_USER"`/`"ROLE_AGENT"`. The
 * SDK's `SendMessageRequest.fromJSON` reads `params.message`.
 */
function buildMessageParams(message: { messageId: string; text: string; contextId?: string }): {
  message: Record<string, unknown>;
} {
  return {
    message: {
      messageId: message.messageId,
      role: "ROLE_USER",
      parts: [{ text: message.text }],
      ...(message.contextId !== undefined ? { contextId: message.contextId } : {}),
    },
  };
}

describe("Gateway E2E Integration", () => {
  const mockAgentPath = path.join(process.cwd(), "tests/mock-acp-agent.cjs");

  type OpenSseStream = {
    buffer: string;
    decoder: TextDecoder;
    reader: ReadableStreamDefaultReader<Uint8Array>;
  };

  async function postJsonRpc(baseUrl: string, body: unknown) {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    return response.json();
  }

  async function postJsonRpcStream(baseUrl: string, body: unknown) {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType.startsWith("text/event-stream")).toBe(true);
    const payload = await response.text();

    return payload
      .split("\n\n")
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice("data: ".length)));
  }

  async function openJsonRpcStream(baseUrl: string, body: unknown): Promise<OpenSseStream> {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType.startsWith("text/event-stream")).toBe(true);
    expect(response.body).toBeTruthy();

    return {
      buffer: "",
      decoder: new TextDecoder(),
      // biome-ignore lint/style/noNonNullAssertion: guarded by expect(response.body).toBeTruthy() above
      reader: response.body!.getReader(),
    };
  }

  async function readNextJsonRpcSseEvent(stream: OpenSseStream): Promise<unknown | null> {
    while (true) {
      const separatorIndex = stream.buffer.indexOf("\n\n");
      if (separatorIndex >= 0) {
        const rawChunk = stream.buffer.slice(0, separatorIndex).trim();
        stream.buffer = stream.buffer.slice(separatorIndex + 2);
        if (!rawChunk) {
          continue;
        }

        const dataLine = rawChunk
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("data: "));
        if (!dataLine) {
          continue;
        }
        return JSON.parse(dataLine.slice("data: ".length));
      }

      const { done, value } = await stream.reader.read();
      if (done) {
        const trailingChunk = stream.buffer.trim();
        stream.buffer = "";
        if (!trailingChunk) {
          return null;
        }
        const dataLine = trailingChunk
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("data: "));
        return dataLine ? JSON.parse(dataLine.slice("data: ".length)) : null;
      }

      stream.buffer += stream.decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    }
  }

  test("Full Round-trip: Discovery -> Handshake -> Message -> Aggregated Result", async () => {
    // 1. Spawn the mock ACP agent
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    // 2. Initialize the Gateway with the mock agent's stream
    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, gatewayCard);

    // 3. Start server on dynamic port
    const server = await serverWrapper.start(0);
    const port = server.port;
    const baseUrl = `http://localhost:${port}`;

    try {
      // 4. Verify Discovery (Agent Card)
      const cardResp = await fetch(`${baseUrl}/.well-known/agent-card.json`);
      const card = await cardResp.json();
      expect(card.name).toBe("e2e-test-gateway");
      // A2A 1.0: transport URL lives in supportedInterfaces[].url, and the
      // protocol version is per-interface (no top-level url/protocolVersion).
      expect(card.supportedInterfaces[0].url).toBe(`http://127.0.0.1:${port}`);
      expect(card.supportedInterfaces[0].protocolVersion).toBe(CURRENT_A2A_PROTOCOL_VERSION);
      expect(card.version).toBe("1.0.0");
      expect(card.skills).toEqual([]);
      expect(card.defaultInputModes).toEqual(["text"]);
      expect(card.defaultOutputModes).toEqual(["text"]);
      expect(card.capabilities["text-to-text"]).toEqual({});
      expect(card.capabilities.streaming).toBe(true);
      // Verify capability mapping worked (multimodal is true in mock agent)
      expect(card.capabilities.multimodal).toBe(true);

      // 5. Verify Message Turn (SendMessage)
      const messageId = `msg-${Date.now()}`;
      const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: buildMessageParams({ messageId, text: "Hello Mock!" }),
      };

      console.log("[Test] Sending SendMessage request...");
      const result = await postJsonRpc(baseUrl, payload);
      console.log("[Test] Received result:", JSON.stringify(result));

      // 6. Validate Aggregated Response. A2A 1.0 SendMessage returns
      // `{ task }` (a Task wrapper, not a bare result). The turn terminates
      // with a terminal status-update; the SDK folds the agent reply into the
      // final Task's `status.message`. Our mock sends two chunks
      // ("Hello from " + "Mock ACP Agent!") which accumulate into one reply.
      expect(result.jsonrpc).toBe("2.0");
      const task = result.result.task;
      expect(task.id).toEqual(expect.any(String));
      expect(task.contextId).toEqual(expect.any(String));
      expect(task.status.state).toBe("TASK_STATE_COMPLETED");
      // Agent reply rides the terminal status-update's message (proto text part).
      expect(task.status.message.parts[0].text).toBe("Hello from Mock ACP Agent!");

      // 7. Verify GetTask resolves the returned taskId. GetTask returns a
      // bare Task (no `{ task }` wrapper — unlike SendMessage).
      const taskResult = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "GetTask",
        params: { id: task.id },
      });
      expect(taskResult.result.id).toBe(task.id);
      expect(taskResult.result.contextId).toBe(task.contextId);
      expect(taskResult.result.status.state).toBe("TASK_STATE_COMPLETED");
    } finally {
      // Cleanup
      server.stop();
      acp.kill();
    }
  }, 30000); // 30s timeout

  test("Rejects SendMessage with a missing required message at the proto-decode boundary", async () => {
    // A2A 1.0 ingress contract: the SDK gates on the JSON-RPC envelope and the
    // proto decode of the params. A valid method (`SendMessage`) whose params
    // omit the required `message` (and its required `messageId`) is rejected
    // with INVALID_PARAMS (-32602) BEFORE the executor runs — verified
    // empirically: no "Bridging A2A goal to ACP" log is produced. Unlike A2A
    // 0.3, the rejection rides proto-field validation rather than a separate
    // schema layer, so the error message is proto-internal ("...messageId is
    // required.") and not stable — assert the code, not the string.
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, validationCard);

    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const payload = {
        jsonrpc: "2.0",
        id: 99,
        method: "SendMessage",
        params: {},
      };

      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      expect(result.jsonrpc).toBe("2.0");
      expect(result.id).toBe(99);
      expect(result.error.code).toBe(-32602);
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);

  test("Rejects malformed JSON with parse error", async () => {
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, parseErrorCard);

    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":',
      });

      const result = await response.json();
      expect(result.jsonrpc).toBe("2.0");
      expect(result.id).toBeNull();
      expect(result.error.code).toBe(-32700);
      expect(result.error.message).toBe("Parse error");
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);

  test("Preserves caller-supplied non-sentinel agent card URL after start", async () => {
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, customUrlCard);

    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const cardResp = await fetch(`${baseUrl}/.well-known/agent-card.json`);
      const card = await cardResp.json();

      // The caller-supplied (non-sentinel) interface URL survives `start()`:
      // finalizeDefaultUrl only rewrites the placeholder sentinel.
      expect(card.supportedInterfaces[0].url).toBe("https://gateway.example.test");
      expect(card.name).toBe("e2e-test-gateway");
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);

  test("supports second-turn continuation via contextId without taskId reuse", async () => {
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, gatewayCard);
    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const first = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: buildMessageParams({ messageId: "turn-1", text: "Hello Mock!" }),
      });

      const firstTaskResult = first.result.task;
      expect(firstTaskResult.contextId).toEqual(expect.any(String));
      expect(firstTaskResult.id).toEqual(expect.any(String));

      // Verify the first task is retrievable (GetTask returns a bare Task).
      const firstTask = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 3,
        method: "GetTask",
        params: { id: firstTaskResult.id },
      });
      expect(firstTask.result.id).toBe(firstTaskResult.id);

      const second = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "SendMessage",
        params: buildMessageParams({
          messageId: "turn-2",
          text: "What did I just say?",
          contextId: firstTaskResult.contextId,
        }),
      });

      const secondTaskResult = second.result.task;
      expect(secondTaskResult.contextId).toBe(firstTaskResult.contextId);
      expect(secondTaskResult.id).toEqual(expect.any(String));
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);

  test("tasks/get resolves any taskId returned by message/send", async () => {
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const card = buildAgentCard({
      name: "e2e-test-gateway",
      description: "Testing task persistence",
      capabilities: { "text-to-text": {} },
    });
    const serverWrapper = new UniversalA2AServer(executor, card);
    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    try {
      // Send a message and capture the response (SendMessage → `{ task }`).
      const sendResult = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "SendMessage",
        params: buildMessageParams({ messageId: "task-resolve-1", text: "Hello" }),
      });

      const sentTask = sendResult.result.task;
      const taskId = sentTask.id;
      expect(taskId).toEqual(expect.any(String));

      // GetTask must resolve the returned taskId (bare Task result).
      const getResult = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "GetTask",
        params: { id: taskId },
      });

      expect(getResult.result).toBeDefined();
      expect(getResult.error).toBeUndefined();
      expect(getResult.result.id).toBe(taskId);
      expect(getResult.result.contextId).toBe(sentTask.contextId);
      expect(getResult.result.status.state).toBe("TASK_STATE_COMPLETED");

      // GetTask must fail for a non-existent taskId (TASK_NOT_FOUND).
      const missingResult = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 3,
        method: "GetTask",
        params: { id: "non-existent-task-id" },
      });

      expect(missingResult.error).toBeDefined();
      expect(missingResult.error.code).toBe(-32001);
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);

  test("supports SendStreamingMessage and SubscribeToTask", async () => {
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, gatewayCard);
    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    try {
      const streamResponse = await postJsonRpcStream(baseUrl, {
        jsonrpc: "2.0",
        id: 10,
        method: "SendStreamingMessage",
        params: buildMessageParams({ messageId: "stream-1", text: "Hello Mock!" }),
      });

      // A2A 1.0 streaming lifecycle: initial `task` (SUBMITTED) → ≥1
      // `statusUpdate` (WORKING) → terminal `statusUpdate` (COMPLETED). The
      // terminal event is a status-update, NOT a second `task` — the SDK's
      // ResultManager forbids re-publishing a Task mid-lifecycle.
      expect(streamResponse.length).toBeGreaterThanOrEqual(2);

      const firstTask = streamResponse[0]?.result?.task;
      expect(firstTask?.id).toEqual(expect.any(String));
      expect(firstTask?.status?.state).toBe("TASK_STATE_SUBMITTED");
      const taskId = firstTask.id;

      // An intermediate WORKING status-update must appear.
      expect(
        streamResponse.some(
          (event) => event.result?.statusUpdate?.status?.state === "TASK_STATE_WORKING",
        ),
      ).toBe(true);

      // The final event is a terminal (COMPLETED) status-update for the task.
      const lastResult = streamResponse[streamResponse.length - 1]?.result?.statusUpdate;
      expect(lastResult?.taskId).toBe(taskId);
      expect(lastResult?.status?.state).toBe("TASK_STATE_COMPLETED");

      // SubscribeToTask still opens an SSE stream for a known task. A2A 1.0
      // changed terminal-task replay: a COMPLETED task is no longer replayed
      // on resubscribe (the stream opens and immediately closes with no
      // events), whereas GetTask still resolves it. Assert the SSE channel
      // opens cleanly without replaying terminal events. (The in-flight
      // attach-mid-stream behavior is covered by the next test.)
      const resubscribeResponse = await postJsonRpcStream(baseUrl, {
        jsonrpc: "2.0",
        id: 11,
        method: "SubscribeToTask",
        params: {
          id: taskId,
        },
      });

      expect(resubscribeResponse).toEqual([]);
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);

  test("resubscribes to an in-flight streamed task before terminal completion", async () => {
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, gatewayCard);
    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    let stream: OpenSseStream | undefined;

    try {
      // Hold the task in a non-terminal (WORKING) state long enough to attach
      // a resubscribe stream mid-flight. The mock's `__SLEEP_MS__:<ms>:<tag>`
      // hook delays its prompt reply, keeping the lifecycle open; without it
      // the mock completes in ~150ms and resubscribe would race the terminal
      // state (a COMPLETED task is not replayed — see prior test).
      stream = await openJsonRpcStream(baseUrl, {
        jsonrpc: "2.0",
        id: 12,
        method: "SendStreamingMessage",
        params: buildMessageParams({
          messageId: "stream-inflight-1",
          text: "__SLEEP_MS__:1500:held",
        }),
      });

      const firstEvent = await readNextJsonRpcSseEvent(stream);
      const firstResult = (
        firstEvent as {
          result?: {
            task?: { id?: string };
            statusUpdate?: { taskId?: string };
          };
        }
      )?.result;
      const taskId = firstResult?.task?.id ?? firstResult?.statusUpdate?.taskId;

      expect(taskId).toEqual(expect.any(String));

      const resubscribePromise = postJsonRpcStream(baseUrl, {
        jsonrpc: "2.0",
        id: 13,
        method: "SubscribeToTask",
        params: {
          id: taskId,
        },
      });

      const inFlightEvent = await readNextJsonRpcSseEvent(stream);
      expect(inFlightEvent).not.toBeNull();

      // Resubscribing while the task is in-flight replays the current task
      // snapshot (and any pending updates) for the matching taskId.
      const resubscribeResponse = await resubscribePromise;
      expect(
        resubscribeResponse.some((event) => {
          const result = event.result;
          return result?.task?.id === taskId || result?.statusUpdate?.taskId === taskId;
        }),
      ).toBe(true);
    } finally {
      await stream?.reader.cancel();
      server.stop();
      acp.kill();
    }
  }, 30000);
});
