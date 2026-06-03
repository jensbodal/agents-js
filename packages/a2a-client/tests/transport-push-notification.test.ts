import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  type CancelTaskRequest,
  type DeleteTaskPushNotificationConfigRequest,
  type GetTaskPushNotificationConfigRequest,
  type GetTaskRequest,
  type ListTaskPushNotificationConfigsRequest,
  type SendMessageRequest,
  type Task,
  type TaskPushNotificationConfig,
  TaskState,
} from "@a2a-js/sdk";
import type {
  A2AStreamElement,
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";
import { createMockTarget, makeTask } from "./mock-a2a-transport.ts";

function makeResolvedTarget(): ResolvedAgentTarget {
  const target = createMockTarget("http://127.0.0.1:55363");
  target.card.capabilities = { extensions: [], pushNotifications: true };
  target.capabilities.supportsPushNotifications = true;
  target.capabilities.raw = { extensions: [], pushNotifications: true };
  return target;
}

/**
 * Build a proto-canonical (A2A 1.0) flat {@link TaskPushNotificationConfig}.
 * The 0.3 nested `{ taskId, pushNotificationConfig: { url, id } }` shape
 * flattened to `{ tenant, id, taskId, url, token, authentication }`.
 */
function makeConfig(opts: { taskId: string; id: string; url: string }): TaskPushNotificationConfig {
  return {
    tenant: "",
    id: opts.id,
    taskId: opts.taskId,
    url: opts.url,
    token: "",
    authentication: undefined,
  };
}

/** Mock transport that records push notification method calls. */
class PushNotificationMockTransport implements A2ATransport {
  readonly setCalls: TaskPushNotificationConfig[] = [];
  readonly getCalls: GetTaskPushNotificationConfigRequest[] = [];
  readonly listCalls: ListTaskPushNotificationConfigsRequest[] = [];
  readonly deleteCalls: DeleteTaskPushNotificationConfigRequest[] = [];

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

  async sendMessage(_target: ResolvedAgentTarget, _params: SendMessageRequest): Promise<Task> {
    return makeTask({ id: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_WORKING });
  }

  async *sendMessageStream(): AsyncGenerator<A2AStreamElement> {}

  async getTask(_target: ResolvedAgentTarget, _params: GetTaskRequest): Promise<Task> {
    throw new Error("not implemented");
  }

  async cancelTask(_target: ResolvedAgentTarget, _params: CancelTaskRequest): Promise<Task> {
    throw new Error("not implemented");
  }

  async *resubscribeTask(): AsyncGenerator<A2AStreamElement> {}

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
    const configId = params.id || taskId;
    if (!this.configs.has(taskId)) {
      this.configs.set(taskId, new Map());
    }
    const storedConfig: TaskPushNotificationConfig = { ...params, id: configId };
    this.configs.get(taskId)?.set(configId, storedConfig);
    return storedConfig;
  }

  async getTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    params: GetTaskPushNotificationConfigRequest,
  ): Promise<TaskPushNotificationConfig> {
    this.getCalls.push(params);
    const taskConfigs = this.configs.get(params.taskId);
    if (!taskConfigs || taskConfigs.size === 0) {
      throw new Error("Config not found");
    }
    const configId = params.id || params.taskId;
    const config = taskConfigs.get(configId);
    if (!config) {
      throw new Error(`Config ${configId} not found`);
    }
    return config;
  }

  async listTaskPushNotificationConfigs(
    _target: ResolvedAgentTarget,
    params: ListTaskPushNotificationConfigsRequest,
  ): Promise<TaskPushNotificationConfig[]> {
    this.listCalls.push(params);
    const taskConfigs = this.configs.get(params.taskId);
    return taskConfigs ? Array.from(taskConfigs.values()) : [];
  }

  async deleteTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    params: DeleteTaskPushNotificationConfigRequest,
  ): Promise<void> {
    this.deleteCalls.push(params);
    const taskConfigs = this.configs.get(params.taskId);
    if (taskConfigs) {
      taskConfigs.delete(params.id);
    }
  }
}

function getReq(taskId: string, id: string): GetTaskPushNotificationConfigRequest {
  return { tenant: "", taskId, id };
}
function listReq(taskId: string): ListTaskPushNotificationConfigsRequest {
  return { tenant: "", taskId, pageSize: 0, pageToken: "" };
}
function deleteReq(taskId: string, id: string): DeleteTaskPushNotificationConfigRequest {
  return { tenant: "", taskId, id };
}

describe("A2ATransport push notification methods", () => {
  test("setTaskPushNotificationConfig stores config and returns it", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    const result = await transport.setTaskPushNotificationConfig(
      target,
      makeConfig({ taskId: "task-1", id: "config-1", url: "https://example.com/hook" }),
    );

    expect(result.taskId).toBe("task-1");
    expect(result.url).toBe("https://example.com/hook");
    expect(result.id).toBe("config-1");
    expect(transport.setCalls).toHaveLength(1);
  });

  test("getTaskPushNotificationConfig retrieves a stored config", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    await transport.setTaskPushNotificationConfig(
      target,
      makeConfig({ taskId: "task-1", id: "config-1", url: "https://example.com/hook" }),
    );

    const result = await transport.getTaskPushNotificationConfig(
      target,
      getReq("task-1", "config-1"),
    );

    expect(result.url).toBe("https://example.com/hook");
    expect(transport.getCalls).toHaveLength(1);
    expect(transport.getCalls[0]?.taskId).toBe("task-1");
  });

  test("listTaskPushNotificationConfigs returns all configs for a task", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    await transport.setTaskPushNotificationConfig(
      target,
      makeConfig({ taskId: "task-1", id: "cfg-1", url: "https://example.com/hook1" }),
    );
    await transport.setTaskPushNotificationConfig(
      target,
      makeConfig({ taskId: "task-1", id: "cfg-2", url: "https://example.com/hook2" }),
    );

    const result = await transport.listTaskPushNotificationConfigs(target, listReq("task-1"));

    expect(result).toHaveLength(2);
    expect(transport.listCalls).toHaveLength(1);
  });

  test("listTaskPushNotificationConfigs returns empty array for unknown task", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    const result = await transport.listTaskPushNotificationConfigs(
      target,
      listReq("nonexistent-task"),
    );

    expect(result).toEqual([]);
  });

  test("deleteTaskPushNotificationConfig removes a config", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    await transport.setTaskPushNotificationConfig(
      target,
      makeConfig({ taskId: "task-1", id: "config-1", url: "https://example.com/hook" }),
    );

    await transport.deleteTaskPushNotificationConfig(target, deleteReq("task-1", "config-1"));

    const remaining = await transport.listTaskPushNotificationConfigs(target, listReq("task-1"));
    expect(remaining).toEqual([]);
    expect(transport.deleteCalls).toHaveLength(1);
  });

  test("full CRUD lifecycle through mock transport", async () => {
    const transport = new PushNotificationMockTransport();
    const target = makeResolvedTarget();

    const setResult = await transport.setTaskPushNotificationConfig(
      target,
      makeConfig({ taskId: "task-crud", id: "crud-cfg", url: "https://example.com/hook" }),
    );
    expect(setResult.id).toBe("crud-cfg");

    const getResult = await transport.getTaskPushNotificationConfig(
      target,
      getReq("task-crud", "crud-cfg"),
    );
    expect(getResult.url).toBe("https://example.com/hook");

    const listResult = await transport.listTaskPushNotificationConfigs(
      target,
      listReq("task-crud"),
    );
    expect(listResult).toHaveLength(1);

    await transport.deleteTaskPushNotificationConfig(target, deleteReq("task-crud", "crud-cfg"));

    const afterDelete = await transport.listTaskPushNotificationConfigs(
      target,
      listReq("task-crud"),
    );
    expect(afterDelete).toEqual([]);

    expect(transport.setCalls).toHaveLength(1);
    expect(transport.getCalls).toHaveLength(1);
    expect(transport.listCalls).toHaveLength(2);
    expect(transport.deleteCalls).toHaveLength(1);
  });
});
