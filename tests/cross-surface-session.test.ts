import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACPtoA2AExecutor, buildAgentCard, UniversalA2AServer } from "@agents-js/a2a";
import { spawnACPAgent } from "@agents-js/acp";

const CONTEXT_ID = "shared-session-1";

const crossSurfaceCard = buildAgentCard({
  name: "cross-surface-test-agent",
  description: "Cross-surface session continuity test",
  capabilities: { "text-to-text": {} },
});

interface TaskResult {
  id: string;
  contextId: string;
  status: {
    state: string;
    message?: {
      parts: Array<{ text: string }>;
    };
  };
}

interface JsonRpcResult {
  jsonrpc: string;
  id: number | string;
  // A2A 1.0 SendMessage returns `{ task }`; GetTask returns a bare Task.
  result?: { task?: TaskResult } & Partial<TaskResult>;
  error?: { code: number; message: string };
}

async function postJsonRpc(baseUrl: string, body: unknown): Promise<JsonRpcResult> {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  return response.json() as Promise<JsonRpcResult>;
}

// A2A 1.0: protobuf-canonical message JSON — parts carry `{ text }` (no
// `kind`), role is `"ROLE_USER"`.
function buildMessageSend(
  rpcId: number | string,
  messageId: string,
  text: string,
  contextId: string,
) {
  return {
    jsonrpc: "2.0",
    id: rpcId,
    method: "SendMessage",
    params: {
      message: {
        role: "ROLE_USER",
        messageId,
        contextId,
        parts: [{ text }],
      },
    },
  };
}

describe("Cross-Surface Session Continuity", () => {
  const mockAgentPath = path.join(process.cwd(), "tests/mock-acp-agent.cjs");

  test("two clients sharing a contextId see the same ACP session", async () => {
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, crossSurfaceCard);
    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    try {
      // --- Client A sends a message ---
      const clientA = await postJsonRpc(
        baseUrl,
        buildMessageSend("client-a-1", "msg-client-a", "Hello from Client A", CONTEXT_ID),
      );

      expect(clientA.error).toBeUndefined();
      expect(clientA.result?.task?.status.state).toBe("TASK_STATE_COMPLETED");
      expect(clientA.result?.task?.contextId).toEqual(expect.any(String));

      // --- Client B sends a different message with the same contextId ---
      const clientB = await postJsonRpc(
        baseUrl,
        buildMessageSend("client-b-1", "msg-client-b", "Hello from Client B", CONTEXT_ID),
      );

      expect(clientB.error).toBeUndefined();
      expect(clientB.result?.task?.status.state).toBe("TASK_STATE_COMPLETED");

      expect(clientB.result?.task?.contextId).toBe(clientA.result?.task?.contextId);
      expect(clientB.result?.task?.id).not.toBe(clientA.result?.task?.id);
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);

  test("persistence file maps the shared contextId to a single sessionId", async () => {
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, crossSurfaceCard);
    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    const persistenceContextId = `persistence-test-${Date.now()}`;

    try {
      // Send two messages from different "clients" with the same contextId
      const first = await postJsonRpc(
        baseUrl,
        buildMessageSend("p-1", "msg-p1", "First message", persistenceContextId),
      );
      expect(first.result?.task?.status.state).toBe("TASK_STATE_COMPLETED");

      const second = await postJsonRpc(
        baseUrl,
        buildMessageSend("p-2", "msg-p2", "Second message", persistenceContextId),
      );
      expect(second.result?.task?.status.state).toBe("TASK_STATE_COMPLETED");

      expect(second.result?.task?.contextId).toBe(first.result?.task?.contextId);

      // Verify the persistence layer recorded the mapping
      const persistencePath = path.join(process.cwd(), "_dot", "a2a-sessions.json");
      const raw = readFileSync(persistencePath, "utf-8");
      const sessionData = JSON.parse(raw) as Record<string, string>;

      expect(sessionData[persistenceContextId]).toEqual(expect.any(String));
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);

  test("tasks/get resolves both task IDs from the shared session", async () => {
    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });

    const executor = new ACPtoA2AExecutor(acp.stream);
    const serverWrapper = new UniversalA2AServer(executor, crossSurfaceCard);
    const server = await serverWrapper.start(0);
    const baseUrl = `http://localhost:${server.port}`;

    const tasksGetContextId = `tasks-get-test-${Date.now()}`;

    try {
      const first = await postJsonRpc(
        baseUrl,
        buildMessageSend("tg-1", "msg-tg1", "Turn one", tasksGetContextId),
      );
      expect(first.result?.task?.id).toEqual(expect.any(String));

      const second = await postJsonRpc(
        baseUrl,
        buildMessageSend("tg-2", "msg-tg2", "Turn two", tasksGetContextId),
      );
      expect(second.result?.task?.id).toEqual(expect.any(String));

      // GetTask returns a bare Task (no `{ task }` wrapper).
      const firstGet = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: "tg-get-1",
        method: "GetTask",
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
        params: { id: first.result!.task!.id },
      });
      expect(firstGet.result?.contextId).toBe(tasksGetContextId);

      const secondGet = await postJsonRpc(baseUrl, {
        jsonrpc: "2.0",
        id: "tg-get-2",
        method: "GetTask",
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
        params: { id: second.result!.task!.id },
      });
      expect(secondGet.result?.contextId).toBe(tasksGetContextId);

      expect(firstGet.result?.contextId).toBe(secondGet.result?.contextId);
    } finally {
      server.stop();
      acp.kill();
    }
  }, 30000);
});
