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
  /**
   * Per-task running concatenation of agent-message text. Mirrored from
   * the `AcpStreamingTranslator`'s cumulative text via the executor's
   * sink so the terminal-task `finalText` (line ~343) and the buffer-cap
   * test (`maxTextBufferSize`) stay backed by executor-owned state.
   * Translator owns the per-`messageId` accumulation; the sink truncates
   * to `maxTextBufferSize` here to enforce the executor-level policy.
   */
  agentMessageText: string;
  contextId: string;
  currentAgentMessageId?: string;
  eventBus: ExecutionEventBus;
  pendingAuth?: PendingAuthRequest;
  pendingElicitation?: PendingElicitationRequest;
  runPromise?: Promise<void>;
  sessionId?: string;
  /** One translator per active ACP session-bound task. Constructed lazily
   *  the first time a streaming sessionUpdate arrives. */
  streamingTranslator?: AcpStreamingTranslator;
  taskId: string;
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
        // Lazy-instantiate the translator on first streaming event so the
        // executor doesn't pay translator-state cost for tasks that never
        // stream text (e.g. ones that fail before any chunk).
        if (!task.streamingTranslator) {
          task.streamingTranslator = new AcpStreamingTranslator();
        }
        task.streamingTranslator.feed(params, this.createSink(task));
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
      agentMessageText: "",
      contextId: context.contextId,
      eventBus,
      taskId: context.taskId,
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
      const finalText = task.agentMessageText || "Prompt completed.";
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
   * Build the streaming sink for a task. Each `agent_message_chunk`
   * results in one published `Message` event carrying *cumulative* text;
   * the A2A client provider's `createDeltaAccumulator`
   * (`packages/a2a-client/src/provider.ts:194-207`) computes per-chunk
   * deltas from those by comparing successive `Message.parts[].text`
   * values per `messageId`.
   *
   * Tool-call and thought variants are intentionally not emitted from
   * the executor today — the previous inline handler dropped them, and
   * routing them through the sink without a corresponding A2A wire
   * shape would expand scope beyond the streaming-render fix.
   */
  private createSink(task: ActiveTaskState): AcpStreamingSink {
    return {
      onTextDelta: ({ messageId, delta }) => {
        // First-valid-wins: only adopt the chunk's messageId once. Empty
        // / malformed ids fall through and the terminal-task path
        // synthesizes a UUID at finish time.
        const validMessageId = extractValidAgentMessageId(messageId);
        if (!task.currentAgentMessageId && validMessageId) {
          task.currentAgentMessageId = validMessageId;
        }
        // Mirror the incremental delta onto the executor-owned task
        // state, capped at `maxTextBufferSize`. This is the source of
        // truth for `finalText` (terminal task) and is preserved across
        // ACP `messageId` boundaries (the previous executor used a
        // single flat buffer; preserving that semantics keeps existing
        // history-shape tests passing). Cap-policy is applied here, in
        // the executor sink — the translator stays pure.
        const remaining = this.maxTextBufferSize - task.agentMessageText.length;
        if (remaining > 0) {
          task.agentMessageText += remaining >= delta.length ? delta : delta.slice(0, remaining);
        }

        // Publish ONE `Message` event per chunk carrying the executor's
        // currently-accumulated text. Provider's delta accumulator
        // (`packages/a2a-client/src/provider.ts:194-207`) consumes these
        // and emits per-chunk `message.delta` events to client
        // subscribers. Each chunk is its own event (not collapsed into a
        // single TaskStatusUpdateEvent burst), so the SSE encoder
        // flushes between chunks and the TUI paints incrementally.
        const wireMessageId = task.currentAgentMessageId ?? validMessageId ?? crypto.randomUUID();
        const message: Message = {
          kind: "message",
          role: "agent",
          messageId: wireMessageId,
          parts: [{ kind: "text", text: task.agentMessageText }],
          taskId: task.taskId,
          contextId: task.contextId,
        };
        task.eventBus.publish(message);
      },
      // Thought-chunk and tool-call notifications are dropped to preserve
      // the existing executor's surface. Routing them through to A2A
      // requires picking a wire shape (Message vs status-update with
      // structured parts) that's out of scope for the streaming-render
      // fix; the AG-UI consumer handles them via its own path.
      onThoughtDelta: () => {},
      onToolCallStart: () => {},
      onToolCallUpdate: () => {},
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
