import { describe, expect, test } from "bun:test";
import type {
  AgentCard,
  DeleteTaskPushNotificationConfigParams,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import type {
  A2AStreamEvent,
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";

function makeResolvedTarget(): ResolvedAgentTarget {
  return {
    baseUrl: "http://127.0.0.1:55363",
    cardUrl: "http://127.0.0.1:55363/.well-known/agent-card.json",
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    card: {
      name: "mock",
      description: "mock",
      url: "http://127.0.0.1:55363",
      version: "1.0.0",
      protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      capabilities: { pushNotifications: true },
    },
    capabilities: {
      inputModes: ["text"],
      outputModes: ["text"],
      supportsTextInput: true,
      supportsTextOutput: true,
      supportsStreaming: false,
      supportsPushNotifications: true,
      raw: { pushNotifications: true },
    },
  };
}

/** Mock transport that records push notification method calls. */
class PushNotificationMockTransport implements A2ATransport {
  readonly setCalls: TaskPushNotificationConfig[] = [];
  readonly getCalls: GetTaskPushNotificationConfigParams[] = [];
  readonly listCalls: ListTaskPushNotificationConfigParams[] = [];
  readonly deleteCalls: DeleteTaskPushNotificationConfigParams[] = [];

  private configs = new Map<string, Map<string, TaskPushNotificationConfig>>();

  subscribeDebug(): () => void {
    return () => {};
  }

  async resolveTarget(_input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    return makeResolvedTarget();
  }

  async inspectTarget(): Promise<TargetInspection> {
    return { status: "ready" };
  }

  async sendMessage(_target: ResolvedAgentTarget, _params: MessageSendParams): Promise<Task> {
    return {
      kind: "task",
      id: "task-1",
      contextId: "ctx-1",
      status: { state: "working" },
    };
  }

  async *sendMessageStream(): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {}

  async getTask(_target: ResolvedAgentTarget, _params: TaskQueryParams): Promise<Task> {
    throw new Error("not implemented");
  }

  async cancelTask(_target: ResolvedAgentTarget, _params: TaskIdParams): Promise<Task> {
    throw new Error("not implemented");
  }

  async *resubscribeTask(): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {}

  async getExtendedAgentCard(_target: ResolvedAgentTarget): Promise<AgentCard> {
    throw new Error("not implemented");
  }

  async probe() {
    return [];
  }

  async setTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    params: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    this.setCalls.push(params);
    const taskId = params.taskId;
    const configId = params.pushNotificationConfig.id ?? taskId;
    if (!this.configs.has(taskId)) {
      this.configs.set(taskId, new Map());
    }
    const storedConfig = {
      taskId,
      pushNotificationConfig: { ...params.pushNotificationConfig, id: configId },
    };
    this.configs.get(taskId)?.set(configId, storedConfig);
    return storedConfig;
  }

  async getTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    params: GetTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig> {
    this.getCalls.push(params);
    const taskConfigs = this.configs.get(params.id);
    if (!taskConfigs || taskConfigs.size === 0) {
      throw new Error("Config not found");
    }
    const configId = params.pushNotificationConfigId ?? params.id;
    const config = taskConfigs.get(configId);
    if (!config) {
      throw new Error(`Config ${configId} not found`);
    }
    return config;
  }

  async listTaskPushNotificationConfigs(
    _target: ResolvedAgentTarget,
    params: ListTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig[]> {
    this.listCalls.push(params);
    const taskConfigs = this.configs.get(params.id);
    return taskConfigs ? Array.from(taskConfigs.values()) : [];
  }

  async deleteTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    params: DeleteTaskPushNotificationConfigParams,
  ): Promise<void> {
    this.deleteCalls.push(params);
    const taskConfigs = this.configs.get(params.id);
    if (taskConfigs) {
      taskConfigs.delete(params.pushNotificationConfigId);
    }
  }
}

describe("A2ATransport push notification methods", () => {
  test("setTaskPushNotificationConfig stores config and returns it", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    const result = await transport.setTaskPushNotificationConfig(target, {
      taskId: "task-1",
      pushNotificationConfig: {
        url: "https://example.com/hook",
        id: "config-1",
      },
    });

    expect(result.taskId).toBe("task-1");
    expect(result.pushNotificationConfig.url).toBe("https://example.com/hook");
    expect(result.pushNotificationConfig.id).toBe("config-1");
    expect(transport.setCalls).toHaveLength(1);
  });

  test("getTaskPushNotificationConfig retrieves a stored config", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    await transport.setTaskPushNotificationConfig(target, {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook", id: "config-1" },
    });

    const result = await transport.getTaskPushNotificationConfig(target, {
      id: "task-1",
      pushNotificationConfigId: "config-1",
    });

    expect(result.pushNotificationConfig.url).toBe("https://example.com/hook");
    expect(transport.getCalls).toHaveLength(1);
    expect(transport.getCalls[0]?.id).toBe("task-1");
  });

  test("listTaskPushNotificationConfigs returns all configs for a task", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    await transport.setTaskPushNotificationConfig(target, {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook1", id: "cfg-1" },
    });
    await transport.setTaskPushNotificationConfig(target, {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook2", id: "cfg-2" },
    });

    const result = await transport.listTaskPushNotificationConfigs(target, { id: "task-1" });

    expect(result).toHaveLength(2);
    expect(transport.listCalls).toHaveLength(1);
  });

  test("listTaskPushNotificationConfigs returns empty array for unknown task", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    const result = await transport.listTaskPushNotificationConfigs(target, {
      id: "nonexistent-task",
    });

    expect(result).toEqual([]);
  });

  test("deleteTaskPushNotificationConfig removes a config", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    await transport.setTaskPushNotificationConfig(target, {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook", id: "config-1" },
    });

    await transport.deleteTaskPushNotificationConfig(target, {
      id: "task-1",
      pushNotificationConfigId: "config-1",
    });

    const remaining = await transport.listTaskPushNotificationConfigs(target, { id: "task-1" });
    expect(remaining).toEqual([]);
    expect(transport.deleteCalls).toHaveLength(1);
  });

  test("full CRUD lifecycle through mock transport", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    const setResult = await transport.setTaskPushNotificationConfig(target, {
      taskId: "task-crud",
      pushNotificationConfig: { url: "https://example.com/hook", id: "crud-cfg" },
    });
    expect(setResult.pushNotificationConfig.id).toBe("crud-cfg");

    const getResult = await transport.getTaskPushNotificationConfig(target, {
      id: "task-crud",
      pushNotificationConfigId: "crud-cfg",
    });
    expect(getResult.pushNotificationConfig.url).toBe("https://example.com/hook");

    const listResult = await transport.listTaskPushNotificationConfigs(target, {
      id: "task-crud",
    });
    expect(listResult).toHaveLength(1);

    await transport.deleteTaskPushNotificationConfig(target, {
      id: "task-crud",
      pushNotificationConfigId: "crud-cfg",
    });

    const afterDelete = await transport.listTaskPushNotificationConfigs(target, {
      id: "task-crud",
    });
    expect(afterDelete).toEqual([]);

    expect(transport.setCalls).toHaveLength(1);
    expect(transport.getCalls).toHaveLength(1);
    expect(transport.listCalls).toHaveLength(2);
    expect(transport.deleteCalls).toHaveLength(1);
  });
});
