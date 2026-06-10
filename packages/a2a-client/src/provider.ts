import {
  type Message,
  Role,
  type SendMessageRequest,
  type Task,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
// Import the wire-kinds discriminator via the subpath export so the
// browser bundle (apps/web-ui) doesn't drag in the executor + acp-host
// (which transitively pull node:path through @agents-js/policy).
// The /wire-kinds entry is a tiny pure-data module — types + a type
// guard — with zero runtime deps beyond the ACP SDK schema types.
import { isAgentEventMetadata } from "@agents-js/a2a/wire-kinds";
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
  A2AStreamElement,
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
// Idle timeout (see handleTaskResult): max time WITHOUT task progress before the
// poll gives up. Generous because this is the non-streaming fallback — a healthy
// agent emitting any intermediate update resets it; only sustained silence trips
// it. Override per-call via `pollTimeoutMs` (0 = unbounded).
const DEFAULT_POLL_TIMEOUT_MS = 300_000;

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

/**
 * Build a proto-canonical {@link SendMessageRequest} (A2A 1.0). The wire scaffold
 * — Role enum, `content.$case` parts, required `tenant`/`contextId`/`taskId`/
 * `extensions`/`referenceTaskIds`, and the `blocking → returnImmediately`
 * inversion — is contained here at the wire edge. Client-side `SendTurnOptions`
 * stay in plain terms (`blocking`, `acceptedOutputModes`).
 */
function createMessageSendParams(text: string, options: SendTurnOptions = {}): SendMessageRequest {
  const hasOutputModes = !!options.acceptedOutputModes && options.acceptedOutputModes.length > 0;
  // `returnImmediately` is the inverse of the public `blocking` flag (default
  // false = wait for a terminal/interrupted state). Omit the whole
  // configuration when neither output modes nor blocking is specified.
  const configuration: SendMessageRequest["configuration"] =
    hasOutputModes || options.blocking !== undefined
      ? {
          acceptedOutputModes: hasOutputModes ? [...(options.acceptedOutputModes ?? [])] : [],
          taskPushNotificationConfig: undefined,
          returnImmediately: options.blocking === undefined ? false : !options.blocking,
        }
      : undefined;

  return {
    tenant: "",
    configuration,
    metadata: options.metadata,
    message: {
      messageId: randomUuid(),
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text", value: text },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain",
        },
      ],
      contextId: options.contextId ?? "",
      taskId: options.taskId ?? "",
      metadata: options.metadata,
      extensions: [],
      referenceTaskIds: [],
    },
  };
}

/**
 * Discriminate the non-streaming {@link A2ASendResult} (bare `Message | Task`,
 * NO `$case` wrapper). Tasks carry `id`; messages carry `messageId`.
 */
function isMessageResult(result: A2ASendResult): result is Message {
  return "messageId" in result;
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
  "tool_call.progress",
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
  return isTerminalTaskState(event.status?.state);
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
   * Fan an `agent_event_metadata`-shaped TaskStatusUpdateEvent out into typed
   * client events (`reasoning.message.chunk`, `tool_call.start`,
   * `tool_call.end`, `plan.updated`, `commands.updated`, `mode.changed`,
   * `usage.updated`).
   *
   * The wire shape is documented in `@agents-js/a2a/wire-kinds`: the
   * executor publishes TaskStatusUpdateEvents with `state: "working"` and
   * `metadata: AgentEventMetadata`. The metadata fields reuse the ACP
   * SDK's typed shapes (`PlanEntry`, `AvailableCommand`, `Cost`,
   * `SessionModeState`) so the boundary is single-cast — once
   * `isAgentEventMetadata` passes, the discriminated union narrows
   * each `case` without per-field defensive narrowing.
   *
   * A TaskStatusUpdateEvent without a recognized `metadata.kind` is
   * unchanged — the caller falls through to its existing text-delta
   * path. Returns `true` if the event was handled.
   */
  private fanOutAgentEventMetadata(event: TaskStatusUpdateEvent): boolean {
    // Metadata is `{ [key: string]: any } | undefined` on the proto type; cast
    // away `any` so the discriminated-union guard narrows (TS won't narrow `any`).
    const metadata = event.metadata as Record<string, unknown> | undefined;
    if (!isAgentEventMetadata(metadata)) return false;
    const md = metadata;

    switch (md.kind) {
      case "thought": {
        // Defensive guard against malformed metadata only — `delta` is
        // a string per ThoughtMetadata, so we only skip the
        // explicit empty-string case (no chunk to render). A `null`
        // wire payload would have failed `isAgentEventMetadata` above.
        if (md.delta.length === 0) return true;
        this.emit({
          type: "reasoning.message.chunk",
          text: md.delta,
          delta: md.delta,
          messageId: md.messageId,
        });
        return true;
      }
      case "tool-call-start": {
        if (!md.toolCallId) return true;
        this.emit({
          type: "tool_call.start",
          toolCallId: md.toolCallId,
          toolCallName: md.toolName,
          ...(md.status !== undefined ? { status: md.status } : {}),
          ...(md.toolKind !== undefined ? { toolKind: md.toolKind } : {}),
          ...(md.content !== undefined ? { content: md.content } : {}),
          ...(md.locations !== undefined ? { locations: md.locations } : {}),
          ...(md.rawInput !== undefined ? { rawInput: md.rawInput } : {}),
          ...(md.rawOutput !== undefined ? { rawOutput: md.rawOutput } : {}),
        });
        return true;
      }
      case "tool-call-progress": {
        // Non-terminal status transitions and payload-only updates
        // both arrive here. Forward as a first-class client event so
        // receivers can render intermediate progress (status badges,
        // mid-call diff updates) without subscribing to the raw
        // `task.status.updated` stream.
        if (!md.toolCallId) return true;
        this.emit({
          type: "tool_call.progress",
          toolCallId: md.toolCallId,
          ...(md.status !== undefined ? { status: md.status } : {}),
          ...(md.toolKind !== undefined ? { toolKind: md.toolKind } : {}),
          ...(md.content !== undefined ? { content: md.content } : {}),
          ...(md.locations !== undefined ? { locations: md.locations } : {}),
          ...(md.rawInput !== undefined ? { rawInput: md.rawInput } : {}),
          ...(md.rawOutput !== undefined ? { rawOutput: md.rawOutput } : {}),
        });
        return true;
      }
      case "tool-call-end": {
        if (!md.toolCallId) return true;
        this.emit({
          type: "tool_call.end",
          toolCallId: md.toolCallId,
          status: md.status,
          ...(md.toolKind !== undefined ? { toolKind: md.toolKind } : {}),
          ...(md.content !== undefined ? { content: md.content } : {}),
          ...(md.locations !== undefined ? { locations: md.locations } : {}),
          ...(md.rawInput !== undefined ? { rawInput: md.rawInput } : {}),
          ...(md.rawOutput !== undefined ? { rawOutput: md.rawOutput } : {}),
        });
        return true;
      }
      case "plan":
        this.emit({ type: "plan.updated", entries: md.entries });
        return true;
      case "commands":
        this.emit({ type: "commands.updated", commands: md.commands });
        return true;
      case "mode-changed":
        this.emit({ type: "mode.changed", modeId: md.modeId });
        return true;
      case "usage":
        this.emit({
          type: "usage.updated",
          size: md.size,
          used: md.used,
          ...(md.cost !== undefined ? { cost: md.cost } : {}),
        });
        return true;
      case "session-info-updated":
        // Three-state per field: undefined (omitted from wire) → omitted
        // from event so receivers preserve prior; null → forwarded as
        // explicit clear; string → replacement.
        this.emit({
          type: "session.info.updated",
          ...(md.title !== undefined ? { title: md.title } : {}),
          ...(md.updatedAt !== undefined ? { updatedAt: md.updatedAt } : {}),
        });
        return true;
      default: {
        const _exhaustive: never = md;
        return false;
      }
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
          this.transport.resubscribeTask(target, { tenant: "", id: taskId }),
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
          tenant: "",
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
      const task = await this.transport.cancelTask(target, {
        tenant: "",
        id: taskId,
        metadata: undefined,
      });
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
      if (isTerminalTaskState(currentTask.status?.state) && lastText) {
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

    // Idle timeout, not a total-turn cap: `timeoutMs` is the maximum time the
    // task may go WITHOUT progress (a state change or new agent text). Any
    // progress resets the deadline, so a long-running agent that keeps advancing
    // is never killed mid-turn — only genuine silence trips it. `timeoutMs <= 0`
    // disables the timeout entirely (poll until terminal or aborted) for agents
    // that can run a very long time with no intermediate signal.
    const timeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const idleTimeoutEnabled = timeoutMs > 0;
    let deadline = Date.now() + timeoutMs;
    let lastObservedState = currentTask.status?.state;

    while (!isTerminalTaskState(currentTask.status?.state)) {
      if (options.signal?.aborted) {
        this.emit({
          type: "abort.stream",
          reason: abortReason(options.signal),
          contextId: currentTask.contextId,
          taskId: currentTask.id,
        });
        throw createAbortError(options.signal);
      }
      if (idleTimeoutEnabled && Date.now() >= deadline) {
        const error = new Error(
          `[a2a-client] Polling timed out after ${timeoutMs}ms with no task progress. Task "${currentTask.id}" is still in state "${currentTask.status?.state}".`,
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
        tenant: "",
        id: currentTask.id,
        historyLength: options.historyLength ?? DEFAULT_HISTORY_LENGTH,
      });
      this.emit({ type: "task.updated", task: currentTask });

      const nextText = extractLatestAgentText(currentTask);
      // Progress = the task advanced state or produced new agent text. Reset the
      // idle deadline so only true silence (a hung peer) ever times out.
      const stateChanged = currentTask.status?.state !== lastObservedState;
      const textGrew = Boolean(nextText && nextText !== lastText);
      if (stateChanged || textGrew) {
        deadline = Date.now() + timeoutMs;
      }
      lastObservedState = currentTask.status?.state;

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
    stream: AsyncGenerator<A2AStreamElement>,
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

        // Remaining elements are unwrapped A2A stream payloads — discriminate
        // on the proto `$case` tag (wire edge; proto stays contained here).
        if (event.$case === "message") {
          const message = event.value;
          terminalMessage = message;
          latestTaskId = message.taskId || latestTaskId;
          if (message.messageId) {
            currentAgentMessageId = message.messageId;
          }
          const messageText = extractMessageText(message);
          if (messageText && messageText !== lastText) {
            lastText = messageText;
            const delta = computeDelta(message.messageId, messageText);
            this.emit({
              type: "message.delta",
              text: messageText,
              delta,
              messageId: message.messageId,
              message,
              contextId: message.contextId,
              taskId: message.taskId,
            });
          }
          continue;
        }

        if (event.$case === "statusUpdate") {
          const update = event.value;
          latestTaskId = update.taskId;
          if (update.status?.message?.messageId) {
            currentAgentMessageId = update.status.message.messageId;
          }
          this.emit({ type: "task.status.updated", update });

          // Agent-event metadata fan-out: when the executor publishes a
          // TaskStatusUpdateEvent with `metadata.kind` (see
          // @agents-js/a2a/wire-kinds), translate to typed client events.
          // Skips the text-delta path below — these events carry no
          // cumulative agent text in the status message.
          if (this.fanOutAgentEventMetadata(update)) {
            continue;
          }

          // A2A 1.0 terminates a turn with a TERMINAL TaskStatusUpdateEvent
          // (state COMPLETED/FAILED/CANCELED/REJECTED carrying the final agent
          // reply in `status.message`) — there is no terminal Task event. Commit
          // the agent transcript entry here, synthesizing the returned Task from
          // the update so the streaming function still resolves to a Task.
          // INPUT_REQUIRED/AUTH_REQUIRED are NOT terminal and fall through to
          // the delta path (firing message.completed there would clear
          // resumableTaskId and break the elicitation/auth resume path).
          if (isTerminalTaskState(update.status?.state)) {
            const finalText = extractMessageText(update.status?.message) || lastText;
            const synthesized: Task = {
              id: update.taskId,
              contextId: update.contextId,
              status: update.status,
              artifacts: [],
              history: update.status?.message ? [update.status.message] : [],
              metadata: update.metadata,
            };
            currentTask = synthesized;
            if (finalText) {
              lastText = finalText;
              emittedCompletedMessage = true;
              this.emit({
                type: "message.completed",
                text: finalText,
                task: synthesized,
                contextId: update.contextId,
                taskId: update.taskId,
              });
            }
            continue;
          }

          const nextText = extractMessageText(update.status?.message);
          if (nextText && nextText !== lastText) {
            lastText = nextText;
            const delta = computeDelta(update.status?.message?.messageId, nextText);
            this.emit({
              type: "message.delta",
              text: nextText,
              delta,
              messageId: update.status?.message?.messageId,
              message: update.status?.message,
              contextId: update.contextId,
              taskId: update.taskId,
            });
          }
          continue;
        }

        if (event.$case === "artifactUpdate") {
          const update = event.value;
          latestTaskId = update.taskId;
          this.emit({ type: "task.artifact.updated", update });
          continue;
        }

        // event.$case === "task"
        const task = event.value;
        currentTask = task;
        latestTaskId = task.id;
        this.emit({ type: "task.updated", task });
        const completedText = extractLatestAgentText(task);
        // Only fire `message.completed` when the task itself has reached a
        // terminal state (see `isTerminalEvent`). For non-terminal states
        // like `input-required` or `auth-required`, the agent's text is the
        // elicitation prompt — not a completed message arc. Firing
        // message.completed early causes the session reducer to clear
        // `resumableTaskId`, breaking the resume path that
        // respondToElicitation/respondToAuthRequired depend on.
        if (completedText && isTerminalEvent(task)) {
          lastText = completedText;
          emittedCompletedMessage = true;
          this.emit({
            type: "message.completed",
            text: completedText,
            task,
            contextId: task.contextId,
            taskId: task.id,
          });
        } else if (completedText) {
          // Capture the text so any later terminal event can still emit a
          // single completed event without re-deriving from history.
          lastText = completedText;
        }
      }

      if (!currentTask && latestTaskId) {
        currentTask = await this.transport.getTask(target, {
          tenant: "",
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
        isTerminalTaskState(currentTask.status?.state) &&
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
        isTerminalTaskState(currentTask.status?.state) ? "completed" : "exhausted",
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
