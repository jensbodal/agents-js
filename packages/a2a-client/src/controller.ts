import { A2AClientProvider } from "./provider.ts";
import { createInitialSessionState, reduceA2ASessionState } from "./session.ts";
import type {
  A2AEvent,
  A2ASessionState,
  ACPA2AElicitationResponse,
  AgentTargetInput,
  CancelTaskOptions,
  CancelTaskResult,
  ResolvedAgentTarget,
  ResumeTurnOptions,
  SendTurnOptions,
  TargetInspection,
} from "./types.ts";

const TARGET_INSPECTION_DEBOUNCE_MS = 300;
const TARGET_INSPECTION_RETRY_MS = 1_000;

function trimTargetInput(input: AgentTargetInput): AgentTargetInput {
  return {
    ...input,
    url: input.url.trim(),
  };
}

function sameTargetInput(
  left: AgentTargetInput | undefined,
  right: AgentTargetInput | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  const leftHeaders = left.headers ?? {};
  const rightHeaders = right.headers ?? {};
  const leftKeys = Object.keys(leftHeaders).sort();
  const rightKeys = Object.keys(rightHeaders).sort();

  if (left.url !== right.url || left.mode !== right.mode || leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key, index) => key === rightKeys[index] && leftHeaders[key] === rightHeaders[key],
  );
}

export interface A2AClientControllerOptions {
  initialState?: Partial<A2ASessionState>;
  provider?: A2AClientProvider;
}

export class A2AClientController {
  private readonly listeners = new Set<(event: A2AEvent, state: A2ASessionState) => void>();
  private readonly provider: A2AClientProvider;
  private state: A2ASessionState;
  private inspectionTimer: ReturnType<typeof setTimeout> | null = null;
  private inspectionRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private inspectionVersion = 0;

  constructor(options: A2AClientControllerOptions = {}) {
    this.provider = options.provider ?? new A2AClientProvider();
    this.state = createInitialSessionState(options.initialState);
    this.provider.subscribe((event) => this.applyEvent(event));
  }

  subscribe(listener: (event: A2AEvent, state: A2ASessionState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): A2ASessionState {
    return this.state;
  }

  setTargetInput(input: AgentTargetInput): void {
    const nextInput = trimTargetInput(input);
    if (!nextInput.url) {
      this.clearTargetInput();
      return;
    }

    if (sameTargetInput(this.state.targetInput, nextInput)) {
      return;
    }

    this.clearInspectionTimers();
    this.setState({
      ...this.state,
      targetInput: nextInput,
      targetInspection: { status: "idle" },
    });

    this.scheduleInspection(nextInput, TARGET_INSPECTION_DEBOUNCE_MS);
  }

  clearTargetInput(): void {
    this.clearInspectionTimers();
    this.inspectionVersion += 1;
    this.setState({
      ...this.state,
      targetInput: undefined,
      targetInspection: { status: "idle" },
    });
  }

  async inspectTarget(input: AgentTargetInput): Promise<TargetInspection> {
    const nextInput = trimTargetInput(input);
    if (!nextInput.url) {
      return { status: "idle" };
    }

    return this.provider.inspectTarget(nextInput);
  }

  async probe(input: AgentTargetInput) {
    return this.provider.probe(input);
  }

  async connect(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    const nextInput = trimTargetInput(input);
    this.clearInspectionTimers();
    this.setState({
      ...this.state,
      targetInput: nextInput,
      status: "connecting",
      lastError: undefined,
    });

    const target = await this.provider.connect(nextInput);
    return target;
  }

  async sendTurn(text: string, options: Omit<SendTurnOptions, "contextId" | "taskId"> = {}) {
    if (!this.state.target) {
      throw new Error("[a2a-client] Cannot send a turn before connecting to a target.");
    }

    return this.provider.sendTurn(this.state.target, text, {
      ...options,
      contextId: this.state.contextId,
      taskId: this.state.resumableTaskId,
    });
  }

  async resumeTurn(taskId: string, options: ResumeTurnOptions = {}) {
    if (!this.state.target) {
      throw new Error("[a2a-client] Cannot resume a turn before connecting to a target.");
    }
    return this.provider.resumeTurn(this.state.target, taskId, options);
  }

  /**
   * Cancel the active or supplied task at the protocol level.
   *
   * Resolution order for the task id to cancel:
   * 1. `options.taskId` if provided
   * 2. `state.taskId` (active turn task)
   * 3. `state.resumableTaskId` (e.g. input/auth-required suspended task)
   *
   * Returns a structured {@link CancelTaskResult} so UI consumers can
   * distinguish remote-cancel-succeeded from no-target / no-task / failed
   * paths without inspecting the underlying error type. UI clients can still
   * fall back to local cleanup when this returns `no-target` / `no-task` or
   * propagate the `error` for diagnostics on `failed`.
   *
   * Does NOT throw on a transport failure — converts the error into a
   * `failed` outcome. The provider still emits an `error` event so debug
   * subscribers see the underlying cause.
   */
  async cancelTask(options: CancelTaskOptions = {}): Promise<CancelTaskResult> {
    const target = this.state.target;
    if (!target) {
      return { outcome: "no-target" };
    }

    const taskId = options.taskId ?? this.state.taskId ?? this.state.resumableTaskId;
    if (!taskId) {
      return { outcome: "no-task" };
    }

    const contextId = this.state.contextId;

    // Emit `cancellation.requested` synchronously so subscribers can render
    // a "canceling…" affordance before the transport call returns. This event
    // is purely additive — the reducer leaves session state untouched.
    this.applyEvent({ type: "cancellation.requested", taskId, contextId });

    try {
      const task = await this.provider.cancelTask(target, taskId);
      this.applyEvent({ type: "cancellation.succeeded", taskId, contextId });
      return { outcome: "canceled", taskId, task };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.applyEvent({
        type: "cancellation.failed",
        taskId,
        error: message,
        cause: error,
        contextId,
      });
      return { outcome: "failed", taskId, error: message, cause: error };
    }
  }

  /**
   * Respond to an active form elicitation with accept/decline/cancel + content.
   *
   * Resolves the target task via `state.resumableTaskId` ONLY (no fallback to
   * `state.taskId`). This is a deliberate divergence from {@link cancelTask},
   * which falls through `taskId ?? resumableTaskId`. The reason: respond can
   * only be sent to a *suspended* task that's actively awaiting user input —
   * an active in-flight `taskId` is not a valid respond target. Cancel, by
   * contrast, can validly target either an active turn or a suspended task.
   */
  async respondToElicitation(response: ACPA2AElicitationResponse): Promise<void> {
    if (!this.state.target) {
      throw new Error("[a2a-client] Cannot respond to elicitation before connecting to a target.");
    }
    if (!this.state.resumableTaskId) {
      throw new Error("[a2a-client] Cannot respond to elicitation without a resumable task.");
    }

    await this.provider.respondToElicitation(
      this.state.target,
      this.state.resumableTaskId,
      this.state.contextId,
      response,
    );
  }

  /**
   * Respond to an active auth-required prompt with the selected method id.
   *
   * Same resolution rule as {@link respondToElicitation}: uses
   * `state.resumableTaskId` only. See that method's doc comment for the
   * cancel-vs-respond rationale.
   */
  async respondToAuthRequired(methodId: string): Promise<void> {
    if (!this.state.target) {
      throw new Error("[a2a-client] Cannot respond to auth before connecting to a target.");
    }
    if (!this.state.resumableTaskId) {
      throw new Error("[a2a-client] Cannot respond to auth without a resumable task.");
    }

    await this.provider.respondToAuthRequired(
      this.state.target,
      this.state.resumableTaskId,
      methodId,
      this.state.contextId,
    );
  }

  setSessionContext(contextId?: string, taskId?: string): void {
    this.setState({
      ...this.state,
      contextId,
      taskId,
    });
  }

  resetSession(): void {
    this.clearInspectionTimers();
    this.setState(
      createInitialSessionState({
        sessionId: this.state.sessionId,
        target: this.state.target,
        targetInput: this.state.targetInput,
        targetInspection: this.state.targetInspection,
        status: this.state.target ? "connected" : "idle",
      }),
    );
  }

  /**
   * Surface an out-of-band error into session state so the UI layer
   * (header, inspector) can display it. Used for errors that originate
   * outside the provider pipeline — e.g. a TUI-level Ctrl+R reset that
   * throws, or a swallowed submit callback failure.
   *
   * Sets `status: "error"` and populates `lastError`. Callers can clear
   * the error by invoking {@link resetSession} or reconnecting.
   */
  reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setState({
      ...this.state,
      status: "error",
      lastError: message,
    });
  }

  private clearInspectionTimers(): void {
    if (this.inspectionTimer) {
      clearTimeout(this.inspectionTimer);
      this.inspectionTimer = null;
    }

    if (this.inspectionRetryTimer) {
      clearTimeout(this.inspectionRetryTimer);
      this.inspectionRetryTimer = null;
    }
  }

  private scheduleInspection(input: AgentTargetInput, delayMs: number): void {
    const version = ++this.inspectionVersion;
    this.clearInspectionTimers();
    this.inspectionTimer = setTimeout(() => {
      this.inspectionTimer = null;
      void this.runInspection(input, version);
    }, delayMs);
  }

  private scheduleInspectionRetry(input: AgentTargetInput, version: number): void {
    if (version !== this.inspectionVersion) {
      return;
    }

    this.inspectionRetryTimer = setTimeout(() => {
      this.inspectionRetryTimer = null;
      void this.runInspection(input, version);
    }, TARGET_INSPECTION_RETRY_MS);
  }

  private async runInspection(input: AgentTargetInput, version: number): Promise<void> {
    if (version !== this.inspectionVersion || !sameTargetInput(this.state.targetInput, input)) {
      return;
    }

    this.setState({
      ...this.state,
      targetInput: input,
      targetInspection: { status: "probing" },
    });

    const inspection = await this.provider.inspectTarget(input);
    if (version !== this.inspectionVersion || !sameTargetInput(this.state.targetInput, input)) {
      return;
    }

    this.setState({
      ...this.state,
      targetInput: input,
      targetInspection: inspection,
    });

    if (inspection.status === "unreachable") {
      this.scheduleInspectionRetry(input, version);
    }
  }

  private applyEvent(event: A2AEvent): void {
    this.state = reduceA2ASessionState(this.state, event);
    this.notify(event);
    this.notify({ type: "session.updated", state: this.state });
  }

  private setState(nextState: A2ASessionState): void {
    this.state = nextState;
    this.notify({ type: "session.updated", state: this.state });
  }

  private notify(event: A2AEvent): void {
    for (const listener of this.listeners) {
      listener(event, this.state);
    }
  }
}
