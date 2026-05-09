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
import type { BaseEvent, RunAgentInput } from "@agents-js/agui-types";
import { EventType } from "@agents-js/agui-types";
import { extractMessageText } from "../session.ts";
import type {
  A2ARunErrorEvent,
  A2ARunFinishedEvent,
  A2ARunStartedEvent,
  A2ASendResult,
  A2AStreamEvent,
  A2ATransport,
  AgentTargetInput,
  DebugRecord,
  ProbeResult,
  ResolvedAgentTarget,
  TargetInspection,
} from "../types.ts";
import { randomUuid } from "../uuid.ts";
import type { AGUITransport } from "./agui.ts";
import { AGUIUnsupportedOperationError } from "./agui-errors.ts";

/**
 * Adapts an {@link AGUITransport} so it can sit behind the existing
 * `A2AClientProvider` and session reducer without them knowing about the
 * underlying protocol.
 *
 * Semantic bridging:
 * - `sendMessageStream(params)` translates `params.message` into a
 *   `RunAgentInput`, calls `runAgent`, and yields:
 *     - A synthesized `Task` (state: `working`) right after `RUN_STARTED`
 *     - Pass-through `A2AStreamEvent`s (`run.*`, `tool_call.*`, etc.)
 *       for AG-UI events the session reducer already understands
 *     - A synthesized terminal `Task` (state: `completed` | `failed`) after
 *       `RUN_FINISHED` / `RUN_ERROR`
 * - `sendMessage(params)` runs the stream to completion and returns the
 *   synthesized terminal `Task`.
 * - Task-only methods (`getTask`, `cancelTask`, `resubscribeTask`,
 *   push-notification configs) throw {@link AGUIUnsupportedOperationError}.
 *
 * This adapter is intentionally thin. It does not attempt to reconstruct
 * A2A artifacts or conversation history from AG-UI events; the session
 * reducer is already AG-UI-aware and will consume the translated
 * `A2AStreamEvent`s directly.
 */
export class AguiToA2ATransportAdapter implements A2ATransport {
  constructor(private readonly inner: AGUITransport) {}

  subscribeDebug(listener: (record: DebugRecord) => void): () => void {
    return this.inner.subscribeDebug(listener);
  }

  resolveTarget(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    return this.inner.resolveTarget(input);
  }

  inspectTarget(input: AgentTargetInput): Promise<TargetInspection> {
    return this.inner.inspectTarget(input);
  }

  probe(input: AgentTargetInput): Promise<ProbeResult[]> {
    return this.inner.probe(input);
  }

  /**
   * Collapse an AG-UI run stream into the terminal synthesized `Task`.
   * Exposed through the A2A surface as a one-shot send.
   */
  async sendMessage(
    target: ResolvedAgentTarget,
    params: MessageSendParams,
  ): Promise<A2ASendResult> {
    let terminal: Task | undefined;
    for await (const event of this.sendMessageStream(target, params)) {
      if (isTask(event)) {
        terminal = event;
      }
    }
    if (!terminal) {
      throw new AGUIUnsupportedOperationError(
        "sendMessage",
        "[a2a-client] AG-UI stream produced no terminal task; cannot satisfy sendMessage.",
      );
    }
    return terminal;
  }

  sendMessageStream(
    target: ResolvedAgentTarget,
    params: MessageSendParams,
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {
    const inner = this.inner;
    const run = inner.runAgent(target, buildRunAgentInput(params));
    return (async function* () {
      const { threadId, runId, events } = run;
      let initialTaskEmitted = false;
      for await (const event of events) {
        // Always pass the AG-UI event through as an A2AStreamEvent so the
        // session reducer can consume it natively.
        const mapped = mapAguiToStreamEvent(event, { threadId, runId });
        if (mapped) {
          yield mapped;
        }
        if (event.type === EventType.RUN_STARTED && !initialTaskEmitted) {
          yield synthesizeInitialTask(threadId, runId);
          initialTaskEmitted = true;
        } else if (event.type === EventType.RUN_FINISHED) {
          yield synthesizeTerminalTask(threadId, runId, "completed");
        } else if (event.type === EventType.RUN_ERROR) {
          yield synthesizeTerminalTask(
            threadId,
            runId,
            "failed",
            typeof (event as { message?: unknown }).message === "string"
              ? (event as { message?: string }).message
              : undefined,
          );
        }
      }
    })();
  }

  async getTask(_target: ResolvedAgentTarget, _params: TaskQueryParams): Promise<Task> {
    throw new AGUIUnsupportedOperationError("getTask");
  }

  async cancelTask(_target: ResolvedAgentTarget, _params: TaskIdParams): Promise<Task> {
    throw new AGUIUnsupportedOperationError("cancelTask");
  }

  resubscribeTask(
    _target: ResolvedAgentTarget,
    _params: TaskIdParams,
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {
    return (async function* () {
      throw new AGUIUnsupportedOperationError("resubscribeTask");
      // Unreachable, but required to satisfy the generator return type.
      // biome-ignore lint/correctness/noUnreachable: satisfies TS generator inference
      yield undefined as never;
    })();
  }

  async setTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    throw new AGUIUnsupportedOperationError("setTaskPushNotificationConfig");
  }

  async getTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: GetTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig> {
    throw new AGUIUnsupportedOperationError("getTaskPushNotificationConfig");
  }

  async listTaskPushNotificationConfigs(
    _target: ResolvedAgentTarget,
    _params: ListTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig[]> {
    throw new AGUIUnsupportedOperationError("listTaskPushNotificationConfigs");
  }

  async deleteTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: DeleteTaskPushNotificationConfigParams,
  ): Promise<void> {
    throw new AGUIUnsupportedOperationError("deleteTaskPushNotificationConfig");
  }

  async getExtendedAgentCard(target: ResolvedAgentTarget): Promise<AgentCard> {
    // AG-UI has no extended card; return the synthesized base card.
    return target.card;
  }
}

function isTask(value: unknown): value is Task {
  return (
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "task"
  );
}

function buildRunAgentInput(params: MessageSendParams): RunAgentInput {
  const threadId =
    typeof params.message.contextId === "string" && params.message.contextId.length > 0
      ? params.message.contextId
      : randomUuid();
  const runId = randomUuid();
  const content = extractMessageText(params.message);
  return {
    threadId,
    runId,
    messages: [
      {
        id: params.message.messageId ?? randomUuid(),
        role: "user",
        content,
      },
    ],
    tools: [],
    context: [],
    state: undefined,
    forwardedProps: undefined,
  };
}

function synthesizeInitialTask(threadId: string, runId: string): Task {
  return {
    kind: "task",
    id: runId,
    contextId: threadId,
    status: {
      state: "working",
      timestamp: new Date().toISOString(),
    },
    history: [],
    artifacts: [],
  };
}

function synthesizeTerminalTask(
  threadId: string,
  runId: string,
  state: "completed" | "failed",
  errorMessage?: string,
): Task {
  const message: Message | undefined = errorMessage
    ? {
        kind: "message",
        messageId: randomUuid(),
        role: "agent",
        parts: [{ kind: "text", text: errorMessage }],
        contextId: threadId,
        taskId: runId,
      }
    : undefined;
  return {
    kind: "task",
    id: runId,
    contextId: threadId,
    status: {
      state,
      timestamp: new Date().toISOString(),
      ...(message ? { message } : {}),
    },
    history: [],
    artifacts: [],
  };
}

/**
 * Translate a raw AG-UI `BaseEvent` into an `A2AStreamEvent` the session
 * reducer already understands. Returns `undefined` for events that have
 * no session-level meaning (the adapter will still emit synthesized tasks
 * for lifecycle transitions).
 */
function mapAguiToStreamEvent(
  event: BaseEvent,
  ctx: { threadId: string; runId: string },
): A2AStreamEvent | undefined {
  switch (event.type) {
    case EventType.RUN_STARTED: {
      const out: A2ARunStartedEvent = {
        type: "run.started",
        runId: (event as { runId?: string }).runId ?? ctx.runId,
        threadId: (event as { threadId?: string }).threadId ?? ctx.threadId,
      };
      const parentRunId = (event as { parentRunId?: unknown }).parentRunId;
      if (typeof parentRunId === "string") {
        out.parentRunId = parentRunId;
      }
      return out;
    }
    case EventType.RUN_FINISHED: {
      const out: A2ARunFinishedEvent = {
        type: "run.finished",
        runId: (event as { runId?: string }).runId ?? ctx.runId,
        threadId: (event as { threadId?: string }).threadId ?? ctx.threadId,
      };
      const result = (event as { result?: unknown }).result;
      if (result !== undefined) {
        out.result = result;
      }
      return out;
    }
    case EventType.RUN_ERROR: {
      const out: A2ARunErrorEvent = {
        type: "run.error",
        runId: ctx.runId,
        threadId: ctx.threadId,
        message:
          typeof (event as { message?: unknown }).message === "string"
            ? ((event as { message?: string }).message as string)
            : "AG-UI run failed",
      };
      const code = (event as { code?: unknown }).code;
      if (typeof code === "string") {
        out.code = code;
      }
      return out;
    }
    case EventType.TOOL_CALL_START: {
      const e = event as { toolCallId?: string; toolCallName?: string; parentMessageId?: string };
      if (!e.toolCallId || !e.toolCallName) {
        return undefined;
      }
      return {
        type: "tool_call.start",
        toolCallId: e.toolCallId,
        toolCallName: e.toolCallName,
        ...(e.parentMessageId ? { parentMessageId: e.parentMessageId } : {}),
      };
    }
    case EventType.TOOL_CALL_ARGS: {
      const e = event as { toolCallId?: string; delta?: string };
      if (!e.toolCallId || typeof e.delta !== "string") {
        return undefined;
      }
      return {
        type: "tool_call.args",
        toolCallId: e.toolCallId,
        argsChunk: e.delta,
        delta: e.delta,
      };
    }
    case EventType.TOOL_CALL_END: {
      const e = event as { toolCallId?: string };
      if (!e.toolCallId) {
        return undefined;
      }
      return { type: "tool_call.end", toolCallId: e.toolCallId };
    }
    case EventType.REASONING_START: {
      const e = event as { messageId?: string };
      return { type: "reasoning.start", ...(e.messageId ? { messageId: e.messageId } : {}) };
    }
    case EventType.REASONING_END: {
      const e = event as { messageId?: string };
      return { type: "reasoning.end", ...(e.messageId ? { messageId: e.messageId } : {}) };
    }
    case EventType.REASONING_MESSAGE_START: {
      const e = event as { messageId?: string };
      if (!e.messageId) {
        return undefined;
      }
      return { type: "reasoning.message.start", messageId: e.messageId };
    }
    case EventType.REASONING_MESSAGE_CONTENT:
    case EventType.REASONING_MESSAGE_CHUNK: {
      const e = event as { messageId?: string; delta?: string };
      if (typeof e.delta !== "string") {
        return undefined;
      }
      const type =
        event.type === EventType.REASONING_MESSAGE_CONTENT
          ? "reasoning.message.content"
          : "reasoning.message.chunk";
      return {
        type,
        text: e.delta,
        delta: e.delta,
        ...(e.messageId ? { messageId: e.messageId } : {}),
      };
    }
    case EventType.REASONING_MESSAGE_END: {
      const e = event as { messageId?: string };
      if (!e.messageId) {
        return undefined;
      }
      return { type: "reasoning.message.end", messageId: e.messageId };
    }
    default:
      return undefined;
  }
}
