import type { Message, Task, TaskStatus } from "@a2a-js/sdk";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  type AuthenticateRequest,
  type AuthMethod,
  CLIENT_METHODS,
  ClientSideConnection,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type Stream,
} from "@agents-js/acp";
import { type AcpStreamingSink, AcpStreamingTranslator } from "@agents-js/acp-host";
import { buildACPA2ATaskMetadata, extractACPA2AContinuationMetadata } from "./acp-task-metadata.ts";
import { isACPAuthRequiredError, withAuthRetry } from "./executor-auth.ts";
import { buildStatusUpdate, buildTerminalTask, nowIso } from "./executor-events.ts";
import { extractValidAgentMessageId, selectPermissionOutcome } from "./executor-policies.ts";
import { formatErrorMessage } from "./format-error.ts";
import { type A2ALogger, createConsoleLogger } from "./logger.ts";
import { SessionIdStore } from "./persistence.ts";
import type { AgentEventMetadata } from "./wire-kinds.ts";

/**
 * Lifecycle hooks for the {@link ACPtoA2AExecutor}.
 *
 * Mirrors the subset of {@link import("@agents-js/acp-host").SessionHooks}
 * that applies to the A2A-to-ACP bridge. Hosts that want to transform
 * prompt content before it reaches the ACP agent (e.g. A2A mention
 * middleware) inject a `beforePrompt` hook here.
 */
export interface ExecutorHooks {
  /**
   * Called before each prompt is sent to the ACP agent.
   * May return modified content blocks that replace the original prompt,
   * or `undefined` to leave the prompt unchanged.
   */
  beforePrompt?(
    content: ContentBlock[],
    sessionId: string | null,
  ): Promise<ContentBlock[] | undefined> | ContentBlock[] | undefined;
}

/**
 * Safely invoke an executor hook, catching and logging errors.
 * Returns `undefined` if the hook throws, so the caller falls through
 * to the original content.
 */
async function callExecutorHook<T>(
  logger: A2ALogger,
  name: string,
  fn: () => Promise<T> | T,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    logger.warn(`Hook "${name}" threw; continuing without transformation`, {
      error: formatErrorMessage(error),
    });
    return undefined;
  }
}

/** Extract text content from an A2A Message's parts array */
export function getMessageText(message: Message): string {
  return message.parts
    .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

type PendingResolver<T> = {
  promise: Promise<T>;
  reject(error: unknown): void;
  resolve(value: T): void;
};

type PendingAuthRequest = PendingResolver<AuthenticateRequest> & {
  authMethods: AuthMethod[];
};

type PendingElicitationRequest = PendingResolver<CreateElicitationResponse> & {
  request: CreateElicitationRequest;
};

type ActiveTaskState = {
  contextId: string;
  currentAgentMessageId?: string;
  eventBus: ExecutionEventBus;
  pendingAuth?: PendingAuthRequest;
  pendingElicitation?: PendingElicitationRequest;
  runPromise?: Promise<void>;
  sessionId?: string;
  taskId: string;
  /** Cumulative agent message text accumulated by the translator's
   *  `onTextDelta` sink call. Used as the terminal task's reply text.
   *  Capped at `maxTextBufferSize` to bound memory. */
  textBuffer: string;
  /** Per-task translator instance. Owns the per-`messageId` cumulative
   *  state for both message and thought streams. */
  translator: AcpStreamingTranslator;
};

function createDeferred<T>(): PendingResolver<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, reject, resolve };
}

function normalizeUserMessage(message: Message): Message {
  return {
    ...message,
    kind: "message",
  };
}

function mapStopReasonToTaskState(stopReason: PromptResponse["stopReason"]): TaskStatus["state"] {
  switch (stopReason) {
    case "cancelled":
      return "canceled";
    case "refusal":
      return "rejected";
    case "end_turn":
    case "max_tokens":
    case "max_turn_requests":
      return "completed";
    default:
      return "unknown";
  }
}

/** Default maximum text buffer size in bytes (256 KB). */
export const DEFAULT_MAX_TEXT_BUFFER_SIZE = 256 * 1024;

/** Terminal `ToolCallStatus` values per ACP spec
 *  (`@agentclientprotocol/sdk` `types.gen.d.ts`). The non-terminal
 *  values are `"pending"` and `"in_progress"`. Kept as a runtime
 *  set so the executor can gate emit-as-end vs emit-as-progress at
 *  the wire boundary. */
const TERMINAL_TOOL_CALL_STATUSES = new Set<string>(["completed", "failed"]);

function isTerminalToolCallStatus(status: string): boolean {
  return TERMINAL_TOOL_CALL_STATUSES.has(status);
}

/**
 * Bridges A2A execution requests to an ACP agent.
 * Acts as an ACP Client.
 */
export class ACPtoA2AExecutor implements AgentExecutor {
  private static readonly MAX_AUTH_RETRIES = 3;
  private readonly activeTasks = new Map<string, ActiveTaskState>();
  private readonly sessionToTask = new Map<string, string>();
  private connection: ClientSideConnection;
  private acpInfo?: InitializeResponse;
  private initialized = false;
  private sessionIdStore = new SessionIdStore();
  private sessionMap = new Map<string, string>(); // A2A contextId -> ACP sessionId

  private readonly hooks: ExecutorHooks;
  private readonly maxTextBufferSize: number;

  constructor(
    private acpStream: Stream,
    private logger: A2ALogger = createConsoleLogger("Executor"),
    options?: { hooks?: ExecutorHooks; maxTextBufferSize?: number },
  ) {
    this.hooks = options?.hooks ?? {};
    this.maxTextBufferSize = options?.maxTextBufferSize ?? DEFAULT_MAX_TEXT_BUFFER_SIZE;
    const createClientHandlers: ConstructorParameters<typeof ClientSideConnection>[0] = () => ({
      requestPermission: async (params) => {
        this.logger.info("Agent requested permission", {
          title: params.toolCall.title ?? "(untitled tool call)",
        });
        return selectPermissionOutcome(params.options);
      },
      sessionUpdate: async (params) => {
        const task = this.getActiveTaskBySessionId(params.sessionId);
        if (!task) {
          return;
        }

        const update = params.update;

        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          // Capture messageId on first chunk so the terminal task carries
          // it forward — same contract as the pre-refactor executor.
          const chunkMessageId = extractValidAgentMessageId(
            (update as { messageId?: unknown }).messageId,
          );
          if (chunkMessageId && !task.currentAgentMessageId) {
            task.currentAgentMessageId = chunkMessageId;
          }
          // The translator deliberately drops chunks without a
          // `messageId` (it can't accumulate cumulative state without
          // an id). ACP marks `messageId` as nullable / not required,
          // so a spec-shaped harness that omits it would lose the
          // entire visible response if we routed those through the
          // translator. Fall back to the legacy direct-emit path: pull
          // the chunk text, extend the task's textBuffer (cap-aware),
          // and emit a cumulative-text TaskStatusUpdate. Same wire
          // shape the pre-translator executor used.
          if (!chunkMessageId) {
            const chunk = update.content.text || "";
            const remaining = this.maxTextBufferSize - task.textBuffer.length;
            if (remaining > 0) {
              task.textBuffer += chunk.length <= remaining ? chunk : chunk.slice(0, remaining);
            }
            this.publishStatusUpdate(task, {
              state: "working",
              text: task.textBuffer,
              final: false,
            });
            return;
          }
        }

        task.translator.feed(params, this.buildSessionSink(task));
      },
      extMethod: async (method, params) => {
        if (method !== CLIENT_METHODS.elicitation_create) {
          throw RequestError.methodNotFound(method);
        }

        const request = params as CreateElicitationRequest;
        if (!("sessionId" in request)) {
          throw new Error(
            "A2A executor received a request-scoped elicitation; only session-scoped elicitations are supported.",
          );
        }
        const task = this.getActiveTaskBySessionId(request.sessionId);
        if (!task) {
          throw new Error(`No active task for ACP session ${request.sessionId}`);
        }

        if (request.mode !== "form") {
          return { action: "decline" };
        }

        const deferred = createDeferred<CreateElicitationResponse>();
        task.pendingElicitation = {
          ...deferred,
          request,
        };

        this.publishStatusUpdate(task, {
          state: "input-required",
          text: request.message,
          final: false,
          metadata: buildACPA2ATaskMetadata({
            elicitation: {
              request,
            },
          }),
        });

        return await deferred.promise;
      },
    });

    this.connection = new ClientSideConnection(createClientHandlers, this.acpStream);
  }

  async initialize() {
    if (!this.initialized) {
      this.sessionMap = await this.sessionIdStore.load();
      this.initialized = true;
    }

    this.acpInfo = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        elicitation: {
          form: {},
        },
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    this.logger.info("Connected to ACP Agent", { protocolVersion: this.acpInfo.protocolVersion });
    return this.acpInfo;
  }

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const continuation = extractACPA2AContinuationMetadata(context.userMessage.metadata);
    const existingTask = this.activeTasks.get(context.taskId);

    if (continuation?.elicitationResponse && existingTask?.pendingElicitation) {
      existingTask.eventBus = eventBus;
      if (context.task) {
        eventBus.publish({ ...context.task, kind: "task" });
      }
      existingTask.pendingElicitation.resolve(continuation.elicitationResponse);
      await existingTask.runPromise;
      return;
    }

    if (continuation?.authenticate && existingTask?.pendingAuth) {
      existingTask.eventBus = eventBus;
      if (context.task) {
        eventBus.publish({ ...context.task, kind: "task" });
      }
      existingTask.pendingAuth.resolve(continuation.authenticate);
      await existingTask.runPromise;
      return;
    }

    const userText = getMessageText(context.userMessage);
    this.logger.info("Bridging A2A goal to ACP", { userText });

    if (!this.initialized || !this.acpInfo) {
      await this.initialize();
    }

    const task: ActiveTaskState = {
      contextId: context.contextId,
      eventBus,
      taskId: context.taskId,
      textBuffer: "",
      translator: new AcpStreamingTranslator(),
    };
    this.activeTasks.set(context.taskId, task);

    task.runPromise = this.runTask(context, task, userText);
    await task.runPromise;
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const activeTask = this.activeTasks.get(taskId);
    if (!activeTask?.sessionId) {
      eventBus.finished();
      return;
    }

    try {
      await this.connection.cancel({ sessionId: activeTask.sessionId });
    } finally {
      eventBus.finished();
    }
  }

  private async runTask(
    context: RequestContext,
    task: ActiveTaskState,
    userText: string,
  ): Promise<void> {
    const normalizedUserMessage = normalizeUserMessage(context.userMessage);

    this.publishTask(task, {
      kind: "task",
      id: task.taskId,
      contextId: task.contextId,
      status: {
        state: "submitted",
        timestamp: nowIso(),
      },
      history: [normalizedUserMessage],
    });

    try {
      const sessionId = await this.ensureSession(task);
      this.publishStatusUpdate(task, {
        state: "working",
        final: false,
      });

      const result = await this.runPromptWithRecovery(task, sessionId, userText);
      const finalState = mapStopReasonToTaskState(result.stopReason);
      const finalText = task.textBuffer || "Prompt completed.";
      this.publishTask(
        task,
        buildTerminalTask(task.taskId, task.contextId, normalizedUserMessage, {
          state: finalState,
          text: finalText,
          messageId: task.currentAgentMessageId ?? crypto.randomUUID(),
        }),
      );
      task.eventBus.finished();
    } catch (error) {
      this.logger.error("ACP task failed", { error: formatErrorMessage(error) });
      this.publishTask(
        task,
        buildTerminalTask(task.taskId, task.contextId, normalizedUserMessage, {
          state: "failed",
          text: formatErrorMessage(error, "Unexpected ACP error"),
        }),
      );
      task.eventBus.finished();
      throw error;
    } finally {
      this.rejectPending(task, new Error("Task finished"));
      this.cleanupTask(task);
    }
  }

  private async ensureSession(task: ActiveTaskState): Promise<string> {
    let sessionId = task.sessionId ?? this.sessionMap.get(task.contextId);

    if (!sessionId) {
      sessionId = await withAuthRetry(
        async () => {
          const session = await this.connection.newSession({
            cwd: process.cwd(),
            mcpServers: [],
          });
          this.sessionMap.set(task.contextId, session.sessionId);
          await this.sessionIdStore.save(this.sessionMap);
          this.logger.info("Created ACP session", {
            sessionId: session.sessionId,
            contextId: task.contextId,
          });
          return session.sessionId;
        },
        (error) => this.tryHandleAuthRequired(task, error),
        ACPtoA2AExecutor.MAX_AUTH_RETRIES,
      );
    }

    task.sessionId = sessionId;
    this.sessionToTask.set(sessionId, task.taskId);
    return sessionId;
  }

  private async runPromptWithRecovery(
    task: ActiveTaskState,
    sessionId: string,
    userText: string,
  ): Promise<PromptResponse> {
    let promptContent: ContentBlock[] = [{ type: "text", text: userText }];

    if (this.hooks.beforePrompt) {
      const transformed = await callExecutorHook(this.logger, "beforePrompt", () =>
        this.hooks.beforePrompt?.(promptContent, sessionId),
      );
      if (transformed) {
        promptContent = transformed;
      }
    }

    return withAuthRetry(
      () =>
        this.connection.prompt({
          sessionId,
          prompt: promptContent,
        }),
      (error) => this.tryHandleAuthRequired(task, error),
      ACPtoA2AExecutor.MAX_AUTH_RETRIES,
    );
  }

  private async tryHandleAuthRequired(task: ActiveTaskState, error: unknown): Promise<boolean> {
    if (!isACPAuthRequiredError(error) || !this.acpInfo?.authMethods?.length) {
      return false;
    }

    const deferred = createDeferred<AuthenticateRequest>();
    task.pendingAuth = {
      ...deferred,
      authMethods: [...this.acpInfo.authMethods],
    };

    this.publishStatusUpdate(task, {
      state: "auth-required",
      text: "Authentication is required before the ACP task can continue.",
      final: false,
      metadata: buildACPA2ATaskMetadata({
        authRequired: {
          authMethods: [...this.acpInfo.authMethods],
        },
      }),
    });

    const request = await deferred.promise;
    await this.connection.authenticate(request);
    this.publishStatusUpdate(task, {
      state: "working",
      text: "Authentication accepted. Resuming task...",
      final: false,
    });
    task.pendingAuth = undefined;
    return true;
  }

  private publishTask(task: ActiveTaskState, nextTask: Task): void {
    task.eventBus.publish(nextTask);
  }

  private publishStatusUpdate(
    task: ActiveTaskState,
    options: Parameters<typeof buildStatusUpdate>[2],
  ): void {
    task.eventBus.publish(buildStatusUpdate(task.taskId, task.contextId, options));
  }

  /**
   * Build the `AcpStreamingSink` for a task. The sink translates every
   * translator emission into a `TaskStatusUpdateEvent` with `state: "working"`
   * and a typed `metadata.kind` (see `wire-kinds.ts`) so the A2A client's
   * provider can fan events into typed client events without re-parsing.
   *
   * Why TaskStatusUpdateEvent and not Message events: `@a2a-js/sdk`'s server
   * `events()` AsyncGenerator treats any `Message` as terminal — emitting a
   * thought/tool/plan/etc. Message would end the stream prematurely. The
   * v0.3.0 work hit this exact bug and reverted (commit c93c95a) for
   * `agent_message_chunk` alone; we extend the same TaskStatusUpdateEvent
   * pattern to cover all non-terminal agent signals.
   */
  private buildSessionSink(task: ActiveTaskState): AcpStreamingSink {
    const publishMetadata = (metadata: AgentEventMetadata) => {
      this.publishStatusUpdate(task, {
        state: "working",
        final: false,
        metadata: metadata as unknown as Record<string, unknown>,
      });
    };

    return {
      onTextDelta: ({ messageId, delta }) => {
        // Mirror cumulative text onto the task's textBuffer so the
        // terminal task carries the full reply. Cap policy stays
        // executor-owned (per maxTextBufferSize); translator does not
        // know about size limits.
        const remaining = this.maxTextBufferSize - task.textBuffer.length;
        if (remaining > 0) {
          const additional = delta.length <= remaining ? delta : delta.slice(0, remaining);
          task.textBuffer += additional;
        }

        // Carry messageId forward if not yet captured (chunkMessageId
        // capture in sessionUpdate handler is a belt-and-suspenders
        // for the case where the translator drops a chunk).
        if (!task.currentAgentMessageId) {
          task.currentAgentMessageId = messageId;
        }

        // Existing wire shape: cumulative text on TaskStatusUpdateEvent.
        // No metadata.kind — older A2A clients that pre-date the new
        // event surface continue to drive incremental render via the
        // provider's existing delta computation.
        this.publishStatusUpdate(task, {
          state: "working",
          text: task.textBuffer,
          final: false,
          messageId: task.currentAgentMessageId,
        });
      },

      onThoughtDelta: ({ messageId, delta, cumulativeText }) => {
        publishMetadata({
          kind: "thought",
          messageId,
          delta,
          cumulativeText,
        });
      },

      onToolCallStart: ({ toolCallId, title, status }) => {
        publishMetadata({
          kind: "tool-call-start",
          toolCallId,
          toolName: title,
          ...(status !== undefined ? { status } : {}),
        });
      },

      onToolCallUpdate: ({ toolCallId, status, content: _content, rawLocations: _raw }) => {
        // ACP `tool_call_update` notifications carry both intermediate
        // and terminal status transitions. Emitting `tool-call-end`
        // for every update would cause the client to fire `tool_call.end`
        // on intermediate progress (e.g. `pending` → `in_progress`),
        // and the session reducer would prematurely move the call from
        // `activeToolCalls` to `completedToolCalls`. Gate on terminal
        // status; non-terminal updates emit `tool-call-progress` so
        // receivers can update the displayed status without ending the
        // call.
        if (status !== undefined && isTerminalToolCallStatus(status)) {
          publishMetadata({
            kind: "tool-call-end",
            toolCallId,
            status,
          });
          return;
        }
        // No status, or non-terminal status: surface as progress so
        // the TUI can refresh `▶ tool_name (status)` without flipping
        // the call into the completed bucket.
        publishMetadata({
          kind: "tool-call-progress",
          toolCallId,
          status: status ?? "in_progress",
        });
      },

      onPlanUpdate: ({ entries }) => {
        // SDK-typed `PlanEntry[]` flows through unchanged; consumers
        // receive proper `priority: PlanEntryPriority` enums.
        publishMetadata({ kind: "plan", entries });
      },

      onAvailableCommandsUpdate: ({ commands }) => {
        // SDK-typed `AvailableCommand[]` preserves description + input
        // schema for the slash-command autocomplete UI.
        publishMetadata({ kind: "commands", commands });
      },

      onModeChange: ({ currentModeId }) => {
        publishMetadata({
          kind: "mode-changed",
          modeId: currentModeId,
        });
      },

      onUsageUpdate: ({ size, used, cost }) => {
        // SDK `Cost` (`{ amount, currency }`) is forwarded verbatim;
        // `null` is preserved as-is (some harnesses signal "no cost"
        // explicitly).
        publishMetadata({
          kind: "usage",
          size,
          used,
          ...(cost !== undefined ? { cost } : {}),
        });
      },
    };
  }

  private getActiveTaskBySessionId(sessionId: string): ActiveTaskState | undefined {
    const taskId = this.sessionToTask.get(sessionId);
    return taskId ? this.activeTasks.get(taskId) : undefined;
  }

  private rejectPending(task: ActiveTaskState, error: unknown): void {
    task.pendingAuth?.reject(error);
    task.pendingElicitation?.reject(error);
    task.pendingAuth = undefined;
    task.pendingElicitation = undefined;
  }

  private cleanupTask(task: ActiveTaskState): void {
    this.activeTasks.delete(task.taskId);
    if (task.sessionId) {
      this.sessionToTask.delete(task.sessionId);
    }
  }
}
