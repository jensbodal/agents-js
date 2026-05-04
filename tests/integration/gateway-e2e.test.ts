import { describe, expect, test } from "bun:test";
import path from "node:path";
import { ACPtoA2AExecutor, buildAgentCard, UniversalA2AServer } from "@agents-js/a2a";
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

const customUrlCard = buildAgentCard({
  name: "e2e-test-gateway",
  description: "Testing custom URL preservation",
  url: "https://gateway.example.test",
  capabilities: { "text-to-text": {} },
});

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
      expect(card.url).toBe(`http://127.0.0.1:${port}`);
      expect(card.version).toBe("1.0.0");
      expect(card.protocolVersion).toBe("0.3.0");
      expect(card.skills).toEqual([]);
      expect(card.defaultInputModes).toEqual(["text"]);
      expect(card.defaultOutputModes).toEqual(["text"]);
      expect(card.capabilities["text-to-text"]).toEqual({});
      expect(card.capabilities.streaming).toBe(true);
      // Verify capability mapping worked (multimodal is true in mock agent)
      expect(card.capabilities.multimodal).toBe(true);

      // 5. Verify Message Turn (message/send)
      const messageId = `msg-${Date.now()}`;
      const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            messageId,
            role: "user",
            parts: [{ kind: "text", text: "Hello Mock!" }],
          },
        },
      };

      console.log("[Test] Sending message/send request...");
      const result = await postJsonRpc(baseUrl, payload);
      console.log("[Test] Received result:", JSON.stringify(result));

      // 6. Validate Aggregated Response (Task-shaped, not bare Message)
      // Our mock sends two chunks: "Hello from " and "Mock ACP Agent!"
      expect(result.jsonrpc).toBe("2.0");
      expect(result.result.kind).toBe("task");
      expect(result.result.id).toEqual(expect.any(String));
      expect(result.result.contextId).toEqual(expect.any(String));
      expect(result.result.status.state).toBe("completed");
      // Agent message is carried inside the task's status
      expect(result.result.status.message.parts[0].text).toBe("Hello from Mock ACP Agent!");

      // 7. Verify tasks/get resolves the returned taskId
      const taskResult = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/get",
        params: { id: result.result.id },
      });
      expect(taskResult.result.kind).toBe("task");
      expect(taskResult.result.id).toBe(result.result.id);
      expect(taskResult.result.contextId).toBe(result.result.contextId);
      expect(taskResult.result.status.state).toBe("completed");
    } finally {
      // Cleanup
      server.stop();
      acp.kill();
    }
  }, 30000); // 30s timeout

  test("Rejects invalid message/send payload before executor path", async () => {
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
        method: "message/send",
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
      expect(result.error.message).toBe("Invalid params");
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
        body: '{"jsonrpc":"2.0","id":1,"method":"message/send","params":',
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

      expect(card.url).toBe("https://gateway.example.test");
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
        method: "message/send",
        params: {
          message: {
            messageId: "turn-1",
            role: "user",
            parts: [{ kind: "text", text: "Hello Mock!" }],
          },
        },
      });

      expect(first.result.kind).toBe("task");
      expect(first.result.contextId).toEqual(expect.any(String));
      expect(first.result.id).toEqual(expect.any(String));

      // Verify the first task is retrievable
      const firstTask = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/get",
        params: { id: first.result.id },
      });
      expect(firstTask.result.kind).toBe("task");
      expect(firstTask.result.id).toBe(first.result.id);

      const second = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "message/send",
        params: {
          message: {
            messageId: "turn-2",
            role: "user",
            contextId: first.result.contextId,
            parts: [{ kind: "text", text: "What did I just say?" }],
          },
        },
      });

      expect(second.result.kind).toBe("task");
      expect(second.result.contextId).toBe(first.result.contextId);
      expect(second.result.id).toEqual(expect.any(String));
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
      // Send a message and capture the response
      const sendResult = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            messageId: "task-resolve-1",
            role: "user",
            parts: [{ kind: "text", text: "Hello" }],
          },
        },
      });

      expect(sendResult.result.kind).toBe("task");
      const taskId = sendResult.result.id;
      expect(taskId).toEqual(expect.any(String));

      // tasks/get must resolve the returned taskId
      const getResult = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/get",
        params: { id: taskId },
      });

      expect(getResult.result).toBeDefined();
      expect(getResult.error).toBeUndefined();
      expect(getResult.result.kind).toBe("task");
      expect(getResult.result.id).toBe(taskId);
      expect(getResult.result.contextId).toBe(sendResult.result.contextId);
      expect(getResult.result.status.state).toBe("completed");

      // tasks/get must fail for a non-existent taskId
      const missingResult = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: 3,
        method: "tasks/get",
        params: { id: "non-existent-task-id" },
      });

      expect(missingResult.error).toBeDefined();
      expect(missingResult.error.code).toBe(-32001);
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);

  test("supports message/stream and tasks/resubscribe", async () => {
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
        method: "message/stream",
        params: {
          message: {
            messageId: "stream-1",
            role: "user",
            parts: [{ kind: "text", text: "Hello Mock!" }],
          },
        },
      });

      expect(streamResponse.length).toBeGreaterThan(0);
      expect(streamResponse.some((event) => event.result?.kind === "status-update")).toBe(true);
      const finalTask = [...streamResponse]
        .reverse()
        .find((event) => event.result?.kind === "task")?.result;
      expect(finalTask?.id).toEqual(expect.any(String));
      expect(finalTask?.status?.state).toBe("completed");

      const resubscribeResponse = await postJsonRpcStream(baseUrl, {
        jsonrpc: "2.0",
        id: 11,
        method: "tasks/resubscribe",
        params: {
          id: finalTask.id,
        },
      });

      expect(resubscribeResponse.length).toBeGreaterThan(0);
      expect(resubscribeResponse[0]?.result?.kind).toBe("task");
      expect(resubscribeResponse[0]?.result?.id).toBe(finalTask.id);
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
      stream = await openJsonRpcStream(baseUrl, {
        jsonrpc: "2.0",
        id: 12,
        method: "message/stream",
        params: {
          message: {
            messageId: "stream-inflight-1",
            role: "user",
            parts: [{ kind: "text", text: "Hello while running!" }],
          },
        },
      });

      const firstEvent = await readNextJsonRpcSseEvent(stream);
      const firstResult = (
        firstEvent as { result?: { id?: string; kind?: string; taskId?: string } }
      )?.result;
      const taskId =
        firstResult?.kind === "task"
          ? firstResult.id
          : firstResult?.kind === "status-update"
            ? firstResult.taskId
            : undefined;

      expect(taskId).toEqual(expect.any(String));

      const resubscribePromise = postJsonRpcStream(baseUrl, {
        jsonrpc: "2.0",
        id: 13,
        method: "tasks/resubscribe",
        params: {
          id: taskId,
        },
      });

      const inFlightEvent = await readNextJsonRpcSseEvent(stream);
      expect(inFlightEvent).not.toBeNull();

      const resubscribeResponse = await resubscribePromise;
      expect(
        resubscribeResponse.some((event) => {
          const result = event.result;
          return (
            (result?.kind === "task" && result.id === taskId) ||
            (result?.kind === "status-update" && result.taskId === taskId)
          );
        }),
      ).toBe(true);
    } finally {
      await stream?.reader.cancel();
      server.stop();
      acp.kill();
    }
  }, 30000);
});
