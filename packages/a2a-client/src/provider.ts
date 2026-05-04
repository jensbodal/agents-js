import type {
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import {
  ACP_A2A_AUTH_REQUIRED_METADATA_KEY,
  buildAcpElicitationResponseMetadata,
} from "./acp-state.ts";
import { extractLatestAgentText, extractMessageText, isTerminalTaskState } from "./session.ts";
import { SdkA2ATransport } from "./transport.ts";
import type {
  A2AEvent,
  A2AEventListener,
  A2ASendResult,
  A2AStreamClosedEvent,
  A2AStreamEvent,
  A2ATransport,
  ACPA2AElicitationResponse,
  AgentTargetInput,
  ResolvedAgentTarget,
  ResumeTurnOptions,
  SendTurnOptions,
  TargetInspection,
} from "./types.ts";
import { randomUuid } from "./uuid.ts";

const DEFAULT_HISTORY_LENGTH = 50;
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Build a DOMException-shaped abort error using the signal's reason when
 * available. Mirrors the behavior of `signal.throwIfAborted()` so callers
 * who `try`/`catch` see a familiar error shape.
 */
function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error("[a2a-client] Operation aborted.");
}

function abortReason(signal?: AbortSignal): string | undefined {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return undefined;
}

function createMessageSendParams(text: string, options: SendTurnOptions = {}): MessageSendParams {
  return {
    configuration:
      options.acceptedOutputModes && options.acceptedOutputModes.length > 0
        ? {
            acceptedOutputModes: [...options.acceptedOutputModes],
            ...(options.blocking === undefined ? {} : { blocking: options.blocking }),
          }
        : options.blocking === undefined
          ? undefined
          : { blocking: options.blocking },
    message: {
      kind: "message",
      messageId: randomUuid(),
      role: "user",
      parts: [{ kind: "text", text }],
      ...(options.contextId ? { contextId: options.contextId } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    },
  };
}

function isMessageResult(
  result: Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): result is Message {
  return result.kind === "message";
}

function createIgnoredTaskIdRecord(taskId: string): A2AEvent {
  return {
    type: "debug.record",
    record: {
      requestId: randomUuid(),
      timestamp: new Date().toISOString(),
      direction: "inbound",
      kind: "client",
      method: "WARN",
      url: "session://continuity",
      headers: {},
      body: `[a2a-client] Ignoring taskId "${taskId}" from direct message result; continuing with contextId only.`,
    },
  };
}

function isTaskStatusUpdateEvent(input: unknown): input is TaskStatusUpdateEvent {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { kind?: unknown }).kind === "status-update"
  );
}

function isTaskArtifactUpdateEvent(input: unknown): input is TaskArtifactUpdateEvent {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { kind?: unknown }).kind === "artifact-update"
  );
}

/** AG-UI event type strings that may appear in SSE streams. */
const AGUI_STREAM_EVENT_TYPES = new Set([
  "reasoning.start",
  "reasoning.message.start",
  "reasoning.message.content",
  "reasoning.message.end",
  "reasoning.message.chunk",
  "reasoning.end",
  "reasoning.encrypted",
  "tool_call.start",
  "tool_call.args",
  "tool_call.end",
  "run.started",
  "run.finished",
  "run.error",
]);

function isAguiStreamEvent(input: unknown): input is A2AStreamEvent {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { type?: unknown }).type === "string" &&
    AGUI_STREAM_EVENT_TYPES.has((input as { type: string }).type)
  );
}

/** Idle-timer factory used by `handleStreamingResult`. */
interface IdleTimerHandle {
  /** Reset the idle window. Safe to call after `stop()` (no-op once stopped). */
  touch(): void;
  /** Tear down the timer permanently. Idempotent. */
  stop(): void;
}

/**
 * Predicate for "this Task event terminates the streaming arc."
 *
 * Non-terminal task states (e.g. `input-required`, `auth-required`) are
 * intentionally NOT terminal: firing `message.completed` early there clears
 * `resumableTaskId` and breaks the elicitation/auth resume path.
 *
 * The streaming loop in `handleStreamingResult` already dispatches Message /
 * TaskStatusUpdate / TaskArtifact / AgUI events to their own branches (each
 * ending in `continue`) before reaching the call site, so this helper takes
 * a `Task` directly rather than re-checking the wider event union.
 */
function isTerminalEvent(event: Task): boolean {
  return isTerminalTaskState(event.status.state);
}

/**
 * Build a closure that computes incremental message deltas (AG-UI
 * `TextMessageContent.delta` semantics) keyed by `messageId`.
 *
 * Messages without a `messageId` skip the per-id map entirely — we emit the
 * full text as the delta to avoid cross-contamination across multiple
 * anonymous messages. When the previous text is a prefix of the current
 * text, the delta is just the new tail; otherwise (rare: agent reset or
 * full replacement) we emit the full current text so consumers can resync.
 */
function createDeltaAccumulator(): (messageId: string | undefined, currentText: string) => string {
  const previousTextByMessageId = new Map<string, string>();
  return (messageId, currentText) => {
    if (messageId === undefined) {
      return currentText;
    }
    const previous = previousTextByMessageId.get(messageId) ?? "";
    const delta = currentText.startsWith(previous)
      ? currentText.slice(previous.length)
      : currentText;
    previousTextByMessageId.set(messageId, currentText);
    return delta;
  };
}

/**
 * Build an idle-timer wrapper used by the streaming pipeline.
 *
 * Behavior:
 *   - `idleMs <= 0` produces a no-op timer (matches the old "no threshold"
 *     branch — `setTimeout` was simply never armed).
 *   - `touch()` clears any pending callback and re-arms a fresh timer.
 *   - `stop()` clears any pending callback and prevents future arms (so a
 *     `touch()` after `stop()` cannot resurrect the timer — matches the
 *     `streamClosed` guard in the old inline code).
 *
 * The returned closure does not emit anything itself; it forwards the timeout
 * to the caller's `onIdle` callback so the caller can build the
 * `stream.idle` payload with whatever context fields it has at fire time.
 */
function createIdleTimer(options: { idleMs: number; onIdle: () => void }): IdleTimerHandle {
  const { idleMs, onIdle } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  return {
    touch() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (idleMs > 0 && !stopped) {
        timer = setTimeout(onIdle, idleMs);
      }
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Event-driven A2A client provider -- the **Provider** layer for A2A communication.
 *
 * Orchestrates turn execution (send, stream, resume), target resolution, and
 * event emission. Delegates all protocol I/O to the injected {@link A2ATransport}.
 *
 * This is the primary building block for A2A consumers. The higher-level
 * `A2AClientController` wraps this provider with session state management.
 *
 * @example
 * ```ts ignore
 * const provider = new A2AClientProvider(); // uses SdkA2ATransport by default
 * provider.subscribe((event) => console.log(event.type));
 * const target = await provider.connect({ url: "http://127.0.0.1:3000" });
 * await provider.sendTurn(target, "Hello, agent!");
 * ```
 */
export class A2AClientProvider {
  private readonly listeners = new Set<A2AEventListener>();
  readonly transport: A2ATransport;

  constructor(transport: A2ATransport = new SdkA2ATransport()) {
    this.transport = transport;
    this.transport.subscribeDebug((record) => {
      this.emit({ type: "debug.record", record });
    });
  }

  /** Subscribe to A2A events (turn lifecycle, messages, tasks, errors, debug). Returns an unsubscribe function. */
  subscribe(listener: A2AEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: A2AEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Resolve an agent target (URL + mode) into a fully connected target with
   * agent card and capability summary. Emits "target.resolved" on success.
   */
  async connect(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    try {
      const target = await this.transport.resolveTarget(input);
      this.emit({ type: "target.resolved", target });
      return target;
    } catch (error) {
      this.emit({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      throw error;
    }
  }

  async probe(input: AgentTargetInput) {
    try {
      return await this.transport.probe(input);
    } catch (error) {
      this.emit({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
        cause: error,
      });
      throw error;
    }
  }

  async inspectTarget(input: AgentTargetInput): Promise<TargetInspection> {
    return this.transport.inspectTarget(input);
  }

  /**
   * Send a user turn to the agent. Automatically chooses streaming or
   * non-streaming based on target capabilities and options.
   *
   * Emits "turn.started" before sending, then "message.delta" / "message.completed"
   * and "task.updated" / "task.status.updated" as the response arrives.
   *
   * @param target - Resolved agent target from {@link connect}.
   * @param text - User message text.
   * @param options - Turn options: contextId, taskId, streaming, blocking, etc.
   * @returns The final result: either a direct reply message or a task-backed flow.
   */
  async sendTurn(
    target: ResolvedAgentTarget,
    text: string,
    options: SendTurnOptions = {},
  ): Promise<A2ASendResult> {
    // Short-circuit on already-aborted signal: emit abort.send and throw
    // before any transport work or run lifecycle event is emitted.
    if (options.signal?.aborted) {
      this.emit({
        type: "abort.send",
        reason: abortReason(options.signal),
        contextId: options.contextId,
        taskId: options.taskId,
      });
      throw createAbortError(options.signal);
    }

    this.emit({
      type: "turn.started",
      text,
      contextId: options.contextId,
      taskId: options.taskId,
      suppressTranscriptEntry: options.suppressTranscriptEntry,
    });

    const runId = randomUuid();
    const threadId = options.contextId ?? randomUuid();
    this.emit({
      type: "run.started",
      runId,
      threadId,
      input: { text },
    });

    try {
      let result: A2ASendResult;
      const streaming = options.stream !== false && target.capabilities.supportsStreaming;
      this.emit({
        type: "request.sent",
        timestamp: new Date().toISOString(),
        streaming,
        contextId: options.contextId,
        taskId: options.taskId,
      });
      if (streaming) {
        result = await this.handleStreamingResult(
          target,
          this.transport.sendMessageStream(target, createMessageSendParams(text, options)),
          {
            signal: options.signal,
            contextId: options.contextId,
            taskId: options.taskId,
            idleThresholdMs: options.idleThresholdMs,
          },
        );
      } else {
        const immediate = await this.transport.sendMessage(
          target,
          createMessageSendParams(text, options),
        );
        if (isMessageResult(immediate)) {
          const messageText = extractMessageText(immediate);
          if (immediate.taskId) {
            this.emit(createIgnoredTaskIdRecord(immediate.taskId));
          }
          this.emit({
            type: "message.completed",
            text: messageText,
            message: immediate,
            contextId: immediate.contextId ?? options.contextId,
          });
          result = immediate;
        } else {
          result = await this.handleTaskResult(target, immediate, options);
        }
      }

      this.emit({
        type: "run.finished",
        runId,
        threadId,
        result,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "error",
        error: message,
        cause: error,
      });
      this.emit({
        type: "run.error",
        runId,
        threadId,
        message,
      });
      throw error;
    }
  }

  /**
   * Resume a previously started task (e.g., after input_required or reconnection).
   * Resubscribes to the task event stream if streaming is supported, otherwise polls.
   */
  async resumeTurn(
    target: ResolvedAgentTarget,
    taskId: string,
    options: ResumeTurnOptions = {},
  ): Promise<Task> {
    if (options.signal?.aborted) {
      this.emit({
        type: "abort.send",
        reason: abortReason(options.signal),
        contextId: options.contextId,
        taskId,
      });
      throw createAbortError(options.signal);
    }

    const runId = randomUuid();
    const threadId = options.contextId ?? randomUuid();
    this.emit({
      type: "run.started",
      runId,
      threadId,
      input: { taskId },
    });

    try {
      let result: Task;
      const streaming = options.stream !== false && target.capabilities.supportsStreaming;
      this.emit({
        type: "request.sent",
        timestamp: new Date().toISOString(),
        streaming,
        contextId: options.contextId,
        taskId,
      });
      if (streaming) {
        const streamResult = await this.handleStreamingResult(
          target,
          this.transport.resubscribeTask(target, { id: taskId }),
          {
            signal: options.signal,
            contextId: options.contextId,
            taskId,
            idleThresholdMs: options.idleThresholdMs,
          },
        );
        if (isMessageResult(streamResult)) {
          throw new Error(
            "[a2a-client] Task resubscribe stream completed with a terminal message instead of a task.",
          );
        }
        result = streamResult;
      } else {
        const task = await this.transport.getTask(target, {
          id: taskId,
          historyLength: options.historyLength ?? DEFAULT_HISTORY_LENGTH,
        });
        result = await this.handleTaskResult(target, task, options);
      }

      this.emit({
        type: "run.finished",
        runId,
        threadId,
        result,
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "error",
        error: message,
        cause: error,
      });
      this.emit({
        type: "run.error",
        runId,
        threadId,
        message,
      });
      throw error;
    }
  }

  /**
   * Cancel an active task at the protocol level.
   *
   * Calls the transport's `cancelTask` and emits a `task.updated` event when
   * the cancellation succeeds so subscribers (controller, UI) can react to
   * the canceled task state. On transport failure, emits an `error` event
   * and rethrows so callers (typically {@link A2AClientController.cancelTask})
   * can convert it into a structured failure outcome.
   */
  async cancelTask(target: ResolvedAgentTarget, taskId: string): Promise<Task> {
    try {
      const task = await this.transport.cancelTask(target, { id: taskId });
      this.emit({ type: "task.updated", task });
      return task;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", error: message, cause: error });
      throw error;
    }
  }

  /** Send an elicitation response (accept/decline/cancel with form data) back to the agent. */
  async respondToElicitation(
    target: ResolvedAgentTarget,
    taskId: string,
    contextId: string | undefined,
    response: ACPA2AElicitationResponse,
  ): Promise<void> {
    const params = createMessageSendParams("", {
      blocking: false,
      contextId,
      metadata: buildAcpElicitationResponseMetadata(response),
      suppressTranscriptEntry: true,
      taskId,
    });

    if (target.capabilities.supportsStreaming) {
      await this.handleStreamingResult(target, this.transport.sendMessageStream(target, params));
      return;
    }

    const result = await this.transport.sendMessage(target, params);
    if (!isMessageResult(result)) {
      await this.handleTaskResult(target, result, {});
    }
  }

  /** Send an auth-required response with the selected method ID back to the agent. */
  async respondToAuthRequired(
    target: ResolvedAgentTarget,
    taskId: string,
    methodId: string,
    contextId?: string,
  ): Promise<void> {
    const params = createMessageSendParams("", {
      blocking: false,
      contextId,
      metadata: {
        [ACP_A2A_AUTH_REQUIRED_METADATA_KEY]: {
          kind: "acp.auth-required",
          methodId,
        },
      },
      suppressTranscriptEntry: true,
      taskId,
    });

    if (target.capabilities.supportsStreaming) {
      await this.handleStreamingResult(target, this.transport.sendMessageStream(target, params));
      return;
    }

    const result = await this.transport.sendMessage(target, params);
    if (!isMessageResult(result)) {
      await this.handleTaskResult(target, result, {});
    }
  }

  private async handleTaskResult(
    target: ResolvedAgentTarget,
    task: Task,
    options: Pick<
      ResumeTurnOptions,
      "poll" | "pollIntervalMs" | "pollTimeoutMs" | "historyLength" | "signal"
    >,
  ): Promise<Task> {
    this.emit({ type: "task.updated", task });

    let currentTask = task;
    let lastText = extractLatestAgentText(currentTask);
    if (lastText) {
      this.emit({
        type: "message.delta",
        text: lastText,
        task: currentTask,
        contextId: currentTask.contextId,
        taskId: currentTask.id,
      });
    }

    if (options.poll === false) {
      if (isTerminalTaskState(currentTask.status.state) && lastText) {
        this.emit({
          type: "message.completed",
          text: lastText,
          task: currentTask,
          contextId: currentTask.contextId,
          taskId: currentTask.id,
        });
      }
      return currentTask;
    }

    const timeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    while (!isTerminalTaskState(currentTask.status.state)) {
      if (options.signal?.aborted) {
        this.emit({
          type: "abort.stream",
          reason: abortReason(options.signal),
          contextId: currentTask.contextId,
          taskId: currentTask.id,
        });
        throw createAbortError(options.signal);
      }
      if (Date.now() >= deadline) {
        const error = new Error(
          `[a2a-client] Polling timed out after ${timeoutMs}ms. Task "${currentTask.id}" is still in state "${currentTask.status.state}".`,
        );
        this.emit({ type: "error", error: error.message, cause: error });
        throw error;
      }

      try {
        await sleep(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, options.signal);
      } catch (error) {
        if (options.signal?.aborted) {
          this.emit({
            type: "abort.stream",
            reason: abortReason(options.signal),
            contextId: currentTask.contextId,
            taskId: currentTask.id,
          });
        }
        throw error;
      }
      currentTask = await this.transport.getTask(target, {
        id: currentTask.id,
        historyLength: options.historyLength ?? DEFAULT_HISTORY_LENGTH,
      });
      this.emit({ type: "task.updated", task: currentTask });

      const nextText = extractLatestAgentText(currentTask);
      if (nextText && nextText !== lastText) {
        lastText = nextText;
        this.emit({
          type: "message.delta",
          text: nextText,
          task: currentTask,
          contextId: currentTask.contextId,
          taskId: currentTask.id,
        });
      }
    }

    const completedText = lastText || extractLatestAgentText(currentTask);
    if (completedText) {
      this.emit({
        type: "message.completed",
        text: completedText,
        task: currentTask,
        contextId: currentTask.contextId,
        taskId: currentTask.id,
      });
    }

    return currentTask;
  }

  private async handleStreamingResult(
    target: ResolvedAgentTarget,
    stream: AsyncGenerator<
      Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
    >,
    abortContext?: {
      signal?: AbortSignal;
      contextId?: string;
      taskId?: string;
      idleThresholdMs?: number;
    },
  ): Promise<A2ASendResult> {
    let currentTask: Task | undefined;
    let emittedCompletedMessage = false;
    let lastText = "";
    let latestTaskId: string | undefined;
    let terminalMessage: Message | undefined;
    // Lifecycle: emit `stream.opened` when entering the for-await loop. The
    // first event arrival emits `stream.first_event`; every subsequent event
    // emits `stream.last_event`. Idle timer emits `stream.idle` after
    // `idleThresholdMs` of silence and clears on any event arrival or close.
    let firstEventSeen = false;
    let streamClosed = false;
    const idleMs = abortContext?.idleThresholdMs ?? 0;
    const idleTimer = createIdleTimer({
      idleMs,
      onIdle: () => {
        this.emit({
          type: "stream.idle",
          timestamp: new Date().toISOString(),
          idleMs,
          thresholdMs: idleMs,
          contextId: abortContext?.contextId ?? currentTask?.contextId,
          taskId: abortContext?.taskId ?? latestTaskId,
        });
      },
    });
    const closeStreamLifecycle = (reason: A2AStreamClosedEvent["reason"]) => {
      if (streamClosed) return;
      streamClosed = true;
      idleTimer.stop();
      this.emit({
        type: "stream.closed",
        timestamp: new Date().toISOString(),
        reason,
        contextId: abortContext?.contextId ?? currentTask?.contextId,
        taskId: abortContext?.taskId ?? latestTaskId,
      });
    };

    this.emit({
      type: "stream.opened",
      timestamp: new Date().toISOString(),
      contextId: abortContext?.contextId,
      taskId: abortContext?.taskId,
    });
    idleTimer.touch();
    // Most-recently-seen agent messageId in this stream. Used to enrich
    // downstream AG-UI events (reasoning.start/end) that arrive without their
    // own messageId so clients can still correlate them to the active message.
    let currentAgentMessageId: string | undefined;
    // Track previously-emitted accumulated text per messageId so we can compute
    // incremental deltas (AG-UI `TextMessageContent.delta` semantics).
    const computeDelta = createDeltaAccumulator();

    try {
      for await (const event of stream) {
        if (abortContext?.signal?.aborted) {
          this.emit({
            type: "abort.stream",
            reason: abortReason(abortContext.signal),
            contextId: abortContext.contextId ?? currentTask?.contextId,
            taskId: abortContext.taskId ?? latestTaskId,
          });
          closeStreamLifecycle("aborted");
          // Best-effort: drop generator; SDK transport iterators don't always
          // expose a return() that closes the underlying SSE — but exiting the
          // for-await loop is sufficient for the test scenarios we cover.
          throw createAbortError(abortContext.signal);
        }

        // Lifecycle: emit `stream.first_event` exactly once on the first
        // arriving event, then `stream.last_event` for every subsequent event
        // (including the first — clients can dedupe by timestamp if needed).
        const eventTimestamp = new Date().toISOString();
        if (!firstEventSeen) {
          firstEventSeen = true;
          this.emit({
            type: "stream.first_event",
            timestamp: eventTimestamp,
            contextId: abortContext?.contextId ?? currentTask?.contextId,
            taskId: abortContext?.taskId ?? latestTaskId,
          });
        }
        this.emit({
          type: "stream.last_event",
          timestamp: eventTimestamp,
          contextId: abortContext?.contextId ?? currentTask?.contextId,
          taskId: abortContext?.taskId ?? latestTaskId,
        });
        idleTimer.touch();

        if (isAguiStreamEvent(event)) {
          // Enrich reasoning.start / reasoning.end events lacking a messageId
          // with the current agent messageId so clients can correlate them to
          // the active assistant message.
          if (
            (event.type === "reasoning.start" || event.type === "reasoning.end") &&
            event.messageId === undefined &&
            currentAgentMessageId !== undefined
          ) {
            this.emit({ ...event, messageId: currentAgentMessageId });
          } else {
            this.emit(event);
          }
          continue;
        }

        if (isMessageResult(event)) {
          terminalMessage = event;
          latestTaskId = event.taskId ?? latestTaskId;
          if (event.messageId !== undefined) {
            currentAgentMessageId = event.messageId;
          }
          const messageText = extractMessageText(event);
          if (messageText && messageText !== lastText) {
            lastText = messageText;
            const delta = computeDelta(event.messageId, messageText);
            this.emit({
              type: "message.delta",
              text: messageText,
              delta,
              messageId: event.messageId,
              message: event,
              contextId: event.contextId,
              taskId: event.taskId,
            });
          }
          continue;
        }

        if (isTaskStatusUpdateEvent(event)) {
          latestTaskId = event.taskId;
          if (event.status.message?.messageId !== undefined) {
            currentAgentMessageId = event.status.message.messageId;
          }
          this.emit({ type: "task.status.updated", update: event });
          const nextText = extractMessageText(event.status.message);
          if (nextText && nextText !== lastText) {
            lastText = nextText;
            const delta = computeDelta(event.status.message?.messageId, nextText);
            this.emit({
              type: "message.delta",
              text: nextText,
              delta,
              messageId: event.status.message?.messageId,
              message: event.status.message,
              contextId: event.contextId,
              taskId: event.taskId,
            });
          }
          continue;
        }

        if (isTaskArtifactUpdateEvent(event)) {
          latestTaskId = event.taskId;
          this.emit({ type: "task.artifact.updated", update: event });
          continue;
        }

        currentTask = event;
        latestTaskId = event.id;
        this.emit({ type: "task.updated", task: event });
        const completedText = extractLatestAgentText(event);
        // Only fire `message.completed` when the task itself has reached a
        // terminal state (see `isTerminalEvent`). For non-terminal states
        // like `input-required` or `auth-required`, the agent's text is the
        // elicitation prompt — not a completed message arc. Firing
        // message.completed early causes the session reducer to clear
        // `resumableTaskId`, breaking the resume path that
        // respondToElicitation/respondToAuthRequired depend on.
        if (completedText && isTerminalEvent(event)) {
          lastText = completedText;
          emittedCompletedMessage = true;
          this.emit({
            type: "message.completed",
            text: completedText,
            task: event,
            contextId: event.contextId,
            taskId: event.id,
          });
        } else if (completedText) {
          // Capture the text so any later terminal event can still emit a
          // single completed event without re-deriving from history.
          lastText = completedText;
        }
      }

      if (!currentTask && latestTaskId) {
        currentTask = await this.transport.getTask(target, {
          id: latestTaskId,
          historyLength: DEFAULT_HISTORY_LENGTH,
        });
        this.emit({ type: "task.updated", task: currentTask });
      }

      if (!currentTask && terminalMessage) {
        const finalText = extractMessageText(terminalMessage);
        if (finalText) {
          this.emit({
            type: "message.completed",
            text: finalText,
            message: terminalMessage,
            contextId: terminalMessage.contextId,
            taskId: terminalMessage.taskId,
          });
        }
        closeStreamLifecycle("completed");
        return terminalMessage;
      }

      if (!currentTask) {
        closeStreamLifecycle("error");
        throw new Error("[a2a-client] Streaming operation completed without yielding a task.");
      }

      const finalText = extractLatestAgentText(currentTask);
      // Mirror the in-loop guard: only emit `message.completed` for terminal
      // task states. A non-terminal stream end (e.g. recovered task in
      // `input-required` after the agent suspended) is NOT a completed
      // message arc and must preserve `resumableTaskId` for the resume path.
      if (
        finalText &&
        isTerminalTaskState(currentTask.status.state) &&
        (!emittedCompletedMessage || finalText !== lastText)
      ) {
        emittedCompletedMessage = true;
        this.emit({
          type: "message.completed",
          text: finalText,
          task: currentTask,
          contextId: currentTask.contextId,
          taskId: currentTask.id,
        });
      }

      closeStreamLifecycle(
        isTerminalTaskState(currentTask.status.state) ? "completed" : "exhausted",
      );
      return currentTask;
    } catch (error) {
      // Re-throw after lifecycle close. Aborts have already emitted
      // `stream.closed` with `aborted` reason via the abort path; only the
      // unhandled-error path lands here.
      if (!streamClosed) {
        closeStreamLifecycle("error");
      }
      throw error;
    }
  }
}
