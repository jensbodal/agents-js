import { EventType } from "@agents-js/agui-types";
import { type AguiEventEnvelope, createAguiEventBridge } from "./agui-event-bridge.ts";
import type { JsonRpcMessage, PromptRunner } from "./browser-acp-shim.ts";
import { DEFAULT_MANIFEST, type ManifestDraft, type ManifestValidator } from "./manifest-schema.ts";

export type RunId = string;

export interface RunRecord {
  id: RunId;
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "completed" | "cancelled" | "errored";
  events: AguiEventEnvelope[];
}

/**
 * Hard cap on per-run AG-UI events held in memory. The trace inspector renders
 * against this buffer; allowing it to grow unboundedly would let a chatty model
 * exhaust the page's heap. 200 covers a typical multi-step run with room to
 * spare; older events fall off FIFO.
 */
export const EVENT_CAP = 200;

export interface PlaygroundState {
  ui: { activeTab: "trace" | "manifest"; theme: "light" | "dark" };
  manifest: ManifestDraft;
  manifestDraft: ManifestDraft;
  runs: Map<RunId, RunRecord>;
  activeRunId: RunId | null;
  /**
   * Replay-mode marker. `nextIndex` is the position in the source run's
   * `events` array that the next replay tick will re-emit. Tracked in
   * state (not closure) so the reducer can cleanly transition the
   * machine without reaching into `createPlaygroundStore` internals.
   */
  replayMode: { runId: RunId; nextIndex: number } | null;
  /**
   * Buffer of re-emitted events during an active replay. Lives separate
   * from `runs[id].events` so the source-of-truth event log is never
   * mutated during replay (a replay-while-watching could otherwise
   * pollute the original run's history).
   *
   * Not capped by `EVENT_CAP`: the source is already bounded (the
   * underlying `runs[id].events` is capped at 200), so the replay buffer
   * inherits that bound by construction.
   */
  replayBuffer: AguiEventEnvelope[];
}

/**
 * Replay tick interval in milliseconds. Deliberately deterministic so
 * users can read the trace at human pace — too fast and the chat pane
 * just flashes; too slow and the replay feels unresponsive. 50ms
 * matches typical streaming-token cadence from a small local model.
 */
export const REPLAY_INTERVAL_MS = 50;

/**
 * Public action union dispatched into the store. Note that several variants
 * carry data that a naive consumer might expect the store to synthesize
 * itself (run ids, timestamps). They are explicit on the action so the
 * reducer stays a pure function of `(state, action)` — no module-scope
 * counters, no wall-clock reads inside reduce. The dispatcher wrapper in
 * `createPlaygroundStore` is responsible for filling these in from injected
 * id-factory and clock dependencies before each `commit`.
 *
 * `FINALIZE_RUN` is dispatched by the run-driver side effect when a runner
 * resolves, throws, or its factory rejects. It is the lifecycle counterpart
 * to the bridge's `RUN_FINISHED` AG-UI event: the AG-UI event populates the
 * trace buffer (`runs[id].events`), `FINALIZE_RUN` flips the state machine.
 * Two consumers, two signals — keep both.
 */
export type StoreAction =
  | { type: "SET_TAB"; tab: "trace" | "manifest" }
  | { type: "TOGGLE_THEME" }
  | { type: "UPDATE_MANIFEST_DRAFT"; patch: Partial<ManifestDraft> }
  | { type: "APPLY_MANIFEST" }
  | { type: "START_RUN"; runId: RunId; prompt: string; startedAt: number }
  | { type: "CANCEL_RUN"; endedAt: number }
  | { type: "FINALIZE_RUN"; runId: RunId; status: "completed" | "errored"; endedAt: number }
  | { type: "RECEIVE_EVENT"; event: AguiEventEnvelope }
  | {
      /**
       * Internal action: a single replay tick re-emitting one event from
       * the source run into `replayBuffer`. Synthesized by the dispatch
       * wrapper's setTimeout chain — never dispatchable from outside.
       * Mirrors the `FINALIZE_RUN` pattern (also internal-only).
       *
       * `replaySeq` is 1-indexed and matches `nextIndex + 1` at the
       * moment the tick fires. Subscribers can use it to discriminate
       * replay frames from live-run frames at the listener level.
       */
      type: "RECEIVE_REPLAY_EVENT";
      runId: RunId;
      event: AguiEventEnvelope;
      replaySeq: number;
    }
  /**
   * Begin a deterministic-interval replay of `runs[runId].events` into
   * `replayBuffer`. Replay precedence rules (enforced by the dispatch
   * wrapper):
   *   - Bad runId → no-op silently (no commit, no timer scheduled).
   *   - Zero-event run → STOP_REPLAY immediately, no ticks scheduled.
   *   - START_REPLAY while another replay is active → cancel the old
   *     timer and restart from the top.
   *   - START_RUN while replay is active → cancel the replay (live runs
   *     are higher priority; replays are an inspection tool).
   *   - STOP_REPLAY while no replay is active → no-op.
   */
  | { type: "START_REPLAY"; runId: RunId }
  | { type: "STOP_REPLAY" }
  | { type: "CLEAR_SESSIONS" };

/**
 * Public dispatch surface. Mirrors `StoreAction` but omits the fields the
 * dispatcher fills in from injected dependencies (`runId`, `startedAt`,
 * `endedAt`, `FINALIZE_RUN` entirely — that one is fired internally by the
 * run-driver, never by external callers).
 *
 * UI components dispatch `{ type: "START_RUN", prompt }` and the store
 * synthesizes the rest. This keeps the call sites readable and the reducer
 * pure at the same time.
 */
export type DispatchAction =
  | Exclude<
      StoreAction,
      | { type: "START_RUN" }
      | { type: "CANCEL_RUN" }
      | { type: "FINALIZE_RUN" }
      | { type: "RECEIVE_REPLAY_EVENT" }
    >
  | { type: "START_RUN"; prompt: string }
  | { type: "CANCEL_RUN" };

export interface PlaygroundStore {
  getState(): PlaygroundState;
  dispatch(action: DispatchAction): void;
  /**
   * Subscribe to post-commit notifications. The listener receives the
   * fully-reduced new state and the canonical `StoreAction` that produced
   * it (after the dispatcher has filled in `runId`/timestamps). No synthetic
   * or `as never` actions ever reach a subscriber.
   */
  subscribe(listener: (state: PlaygroundState, action: StoreAction) => void): () => void;
}

/**
 * Injectable scheduler abstraction over `setTimeout` / `clearTimeout`.
 *
 * WHY a typed surface (not raw globals): the replay engine schedules
 * timer-driven event re-emissions, which need to be deterministic in
 * tests. A fake scheduler lets the test drive each tick by hand and
 * assert state transitions without real wall-clock waits.
 *
 * `ReturnType<typeof setTimeout>` resolves to `Timer` in Bun, `number`
 * in browsers, and `NodeJS.Timeout` under `@types/node`. The union flows
 * through both sites without `as any` so long as the consumer keeps the
 * handle opaque (we never inspect it, only pass it back to clearTimeout).
 */
export interface PlaygroundScheduler {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface CreatePlaygroundStoreDeps {
  /**
   * Factory that produces the runner used to drive `START_RUN`. The shell
   * is responsible for selecting which factory to pass here based on the
   * applied manifest's `runtime` field (mock vs local-wasm-worker); the
   * store never sees more than one runner per lifetime. Switching runtimes
   * requires the shell to recreate the store with a different factory.
   */
  runnerFactory: () => Promise<PromptRunner>;
  validator: ManifestValidator;
  initialManifest?: ManifestDraft;
  /** Injectable clock for deterministic test timestamps. */
  now?: () => number;
  /**
   * Injectable run-id factory. Defaults to closure-local counter so tests
   * within a single Bun worker don't see ids cross-pollute (each store has
   * its own counter). Tests can override for fully deterministic ids.
   */
  runIdFactory?: () => RunId;
  /**
   * Injectable scheduler for the replay engine. Defaults to globals
   * (`setTimeout` / `clearTimeout`). Tests pass a fake scheduler that
   * captures pending callbacks so each replay tick can be driven manually.
   */
  scheduler?: PlaygroundScheduler;
}

/**
 * Pure reducer over `PlaygroundState`. No clock reads, no id generation,
 * no module-scope counters — every value the next state needs comes from
 * the action payload. Same `(state, action)` always yields the same next
 * state.
 *
 * Side effects (driving the runner, calling `cancel()`) live in the
 * dispatcher wrapper inside `createPlaygroundStore`.
 */
function reduce(state: PlaygroundState, action: StoreAction): PlaygroundState {
  switch (action.type) {
    case "SET_TAB":
      return { ...state, ui: { ...state.ui, activeTab: action.tab } };

    case "TOGGLE_THEME":
      return {
        ...state,
        ui: { ...state.ui, theme: state.ui.theme === "light" ? "dark" : "light" },
      };

    case "UPDATE_MANIFEST_DRAFT":
      return {
        ...state,
        manifestDraft: { ...state.manifestDraft, ...action.patch },
      };

    case "APPLY_MANIFEST":
      // Validation gate is applied at dispatch level, not here — the reducer
      // trusts that the dispatcher already ran the validator.
      return { ...state, manifest: state.manifestDraft };

    case "START_RUN": {
      const record: RunRecord = {
        id: action.runId,
        prompt: action.prompt,
        startedAt: action.startedAt,
        status: "running",
        events: [],
      };
      const runs = new Map(state.runs);
      runs.set(action.runId, record);
      return { ...state, runs, activeRunId: action.runId };
    }

    case "RECEIVE_EVENT": {
      if (state.activeRunId === null) return state;
      const run = state.runs.get(state.activeRunId);
      if (!run) return state;
      const events = [...run.events, action.event];
      while (events.length > EVENT_CAP) events.shift();
      const runs = new Map(state.runs);
      runs.set(run.id, { ...run, events });
      return { ...state, runs };
    }

    case "CANCEL_RUN": {
      if (state.activeRunId === null) return state;
      const run = state.runs.get(state.activeRunId);
      if (!run || run.status !== "running") return state;
      const runs = new Map(state.runs);
      runs.set(run.id, { ...run, status: "cancelled", endedAt: action.endedAt });
      return { ...state, runs };
    }

    case "FINALIZE_RUN": {
      const run = state.runs.get(action.runId);
      // Only finalize if still running — guards against races between a
      // resolved runner and an in-flight CANCEL_RUN.
      if (!run || run.status !== "running") return state;
      const runs = new Map(state.runs);
      runs.set(action.runId, { ...run, status: action.status, endedAt: action.endedAt });
      return { ...state, runs };
    }

    case "START_REPLAY": {
      // Reset `replayBuffer` and pin `nextIndex` to 0; the dispatch wrapper
      // schedules the first tick separately.
      const targetRun = state.runs.get(action.runId);
      if (!targetRun) return state;
      return {
        ...state,
        replayMode: { runId: action.runId, nextIndex: 0 },
        replayBuffer: [],
      };
    }

    case "RECEIVE_REPLAY_EVENT": {
      // Defensive guard: only append if a replay is active for this runId.
      // Late ticks after a STOP_REPLAY (timer cancellation race) become no-ops.
      if (!state.replayMode || state.replayMode.runId !== action.runId) return state;
      return {
        ...state,
        replayMode: {
          runId: state.replayMode.runId,
          nextIndex: state.replayMode.nextIndex + 1,
        },
        replayBuffer: [...state.replayBuffer, action.event],
      };
    }

    case "STOP_REPLAY":
      // Clear both the marker and the buffer — replay end means the
      // inspector / chat-pane fall back to the live run's view.
      if (state.replayMode === null && state.replayBuffer.length === 0) return state;
      return { ...state, replayMode: null, replayBuffer: [] };

    case "CLEAR_SESSIONS":
      return {
        ...state,
        runs: new Map(),
        activeRunId: null,
        replayMode: null,
        replayBuffer: [],
      };

    default:
      return state;
  }
}

/**
 * Create a fresh playground store. The store is the single source of truth
 * for the Playground v2 UI: components subscribe, dispatch actions, never
 * own run state directly.
 *
 * State changes flow through `reduce`. Two action shapes (`START_RUN` and
 * `CANCEL_RUN`) trigger side effects beyond the pure reducer:
 * - `START_RUN` calls `runnerFactory()`, drives the returned runner, and
 *   feeds emitted notifications through the AG-UI bridge into
 *   `RECEIVE_EVENT` dispatches. When the runner resolves or rejects, the
 *   driver dispatches a `FINALIZE_RUN` action.
 * - `CANCEL_RUN` invokes the active runner's `cancel()` after the reducer
 *   marks the run cancelled.
 *
 * The reducer itself is synchronous and pure — easy to test. The async
 * orchestration is unit-tested via fake runners (see test file).
 */
export function createPlaygroundStore(deps: CreatePlaygroundStoreDeps): PlaygroundStore {
  const now = deps.now ?? (() => Date.now());
  // Closure-local id counter — keeps deterministic test ids isolated per
  // store instance instead of accumulating across the Bun worker. Consumers
  // who want fully stable ids can inject `runIdFactory`.
  let localCounter = 0;
  const runIdFactory =
    deps.runIdFactory ??
    ((): RunId => {
      localCounter += 1;
      return `run-${localCounter}-${now().toString(36)}`;
    });
  const initialManifest = deps.initialManifest ?? DEFAULT_MANIFEST;
  const scheduler: PlaygroundScheduler = deps.scheduler ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle);
    },
  };
  let state: PlaygroundState = {
    ui: { activeTab: "trace", theme: "light" },
    manifest: initialManifest,
    manifestDraft: initialManifest,
    runs: new Map(),
    activeRunId: null,
    replayMode: null,
    replayBuffer: [],
  };

  const listeners = new Set<(s: PlaygroundState, a: StoreAction) => void>();
  // Track the active runner so CANCEL_RUN can invoke its cancel().
  let activeRunner: PromptRunner | null = null;
  let activeRunSessionId: string | null = null;
  /**
   * Mutable replay timer handle. Lives in closure (not state) because a
   * `Timer` handle is I/O — keeping it out of `PlaygroundState` keeps the
   * reducer pure.
   */
  let replayTimerHandle: ReturnType<typeof setTimeout> | null = null;

  function notify(action: StoreAction): void {
    // Snapshot listeners — guards against unsubscribe-during-dispatch.
    const snapshot = Array.from(listeners);
    for (const l of snapshot) l(state, action);
  }

  function commit(action: StoreAction): void {
    state = reduce(state, action);
    notify(action);
  }

  /**
   * Cancel any pending replay timer. Idempotent — safe to call when no
   * replay is in flight. Always called before either starting a new
   * replay or transitioning out of replay mode (STOP_REPLAY, CLEAR_SESSIONS,
   * a new live START_RUN).
   */
  function cancelReplayTimer(): void {
    if (replayTimerHandle !== null) {
      scheduler.clearTimeout(replayTimerHandle);
      replayTimerHandle = null;
    }
  }

  /**
   * Schedule the next replay tick. Reads the current `replayMode.nextIndex`
   * off state at fire-time (not at schedule-time) so a STOP_REPLAY between
   * scheduling and firing reliably no-ops.
   */
  function scheduleNextReplayTick(): void {
    replayTimerHandle = scheduler.setTimeout(() => {
      replayTimerHandle = null;
      const replay = state.replayMode;
      if (!replay) return;
      const run = state.runs.get(replay.runId);
      if (!run) {
        // Source run vanished mid-replay (e.g. CLEAR_SESSIONS). Stop cleanly.
        commit({ type: "STOP_REPLAY" });
        return;
      }
      const event = run.events[replay.nextIndex];
      if (!event) {
        // Past the end — last event already emitted. Auto-stop.
        commit({ type: "STOP_REPLAY" });
        return;
      }
      commit({
        type: "RECEIVE_REPLAY_EVENT",
        runId: replay.runId,
        event,
        replaySeq: replay.nextIndex + 1,
      });
      // Continue if more events remain.
      if (state.replayMode && state.replayMode.nextIndex < run.events.length) {
        scheduleNextReplayTick();
      } else {
        commit({ type: "STOP_REPLAY" });
      }
    }, REPLAY_INTERVAL_MS);
  }

  function dispatch(action: DispatchAction): void {
    switch (action.type) {
      case "APPLY_MANIFEST": {
        const result = deps.validator(state.manifestDraft);
        if (!result.valid) {
          // Silently ignore — UI is responsible for surfacing the validation
          // error from `validator(state.manifestDraft)` before dispatching.
          // We refuse to mutate `manifest` from an invalid draft.
          return;
        }
        commit(action);
        return;
      }

      case "START_RUN": {
        // A new live run cancels any active replay. Replays are an inspection
        // tool; live runs take priority. Documented on START_REPLAY's JSDoc.
        if (state.replayMode) {
          cancelReplayTimer();
          commit({ type: "STOP_REPLAY" });
        }
        const runId = runIdFactory();
        const startedAt = now();
        commit({ type: "START_RUN", runId, prompt: action.prompt, startedAt });
        // Drive the runner asynchronously — fire-and-forget; the runner
        // emits via the bridge into RECEIVE_EVENT and dispatches
        // FINALIZE_RUN on terminal state.
        void driveRun(runId, action.prompt);
        return;
      }

      case "CANCEL_RUN": {
        const sessionId = activeRunSessionId;
        const runner = activeRunner;
        commit({ type: "CANCEL_RUN", endedAt: now() });
        if (runner && sessionId) runner.cancel(sessionId);
        return;
      }

      case "START_REPLAY": {
        // Bad runId → no-op silently (don't even commit). Cleaner than a
        // synthetic error event; UI gates the button on a non-empty runs map.
        const target = state.runs.get(action.runId);
        if (!target) return;
        // Cancel any already-active replay timer first; the reducer also
        // resets nextIndex/buffer so a re-START on the same run restarts
        // cleanly from the top.
        cancelReplayTimer();
        commit(action);
        if (target.events.length === 0) {
          // Zero-event run: STOP_REPLAY immediately, no ticks scheduled.
          commit({ type: "STOP_REPLAY" });
          return;
        }
        scheduleNextReplayTick();
        return;
      }

      case "STOP_REPLAY": {
        // No-op when no replay is active and buffer is empty (the reducer
        // already short-circuits, but cancelling a null timer is also fine).
        cancelReplayTimer();
        commit(action);
        return;
      }

      case "CLEAR_SESSIONS": {
        cancelReplayTimer();
        commit(action);
        return;
      }

      default:
        commit(action);
    }
  }

  /**
   * Internal dispatcher for actions the run-driver synthesizes (currently
   * just `FINALIZE_RUN`). Kept separate from the public `dispatch` so the
   * type system enforces that callers can't invent these from outside.
   */
  function dispatchInternal(action: StoreAction): void {
    commit(action);
  }

  async function driveRun(runId: RunId, prompt: string): Promise<void> {
    const sessionId = `${runId}-session`;
    activeRunSessionId = sessionId;
    const bridge = createAguiEventBridge({ runId, threadId: sessionId });

    /**
     * Synthesize a RUN_ERROR AGUI event from an unknown thrown value and
     * dispatch it through the public RECEIVE_EVENT path. Pairs with the
     * adjacent `dispatchInternal(FINALIZE_RUN)` — without this, runner
     * failures flip status to "errored" silently and the chat pane / trace
     * inspector render the user's prompt then sit blank (regression covered
     * by the two `RUN_ERROR-emit` tests in playground-store.test.ts).
     */
    const emitRunError = (err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      dispatch({
        type: "RECEIVE_EVENT",
        event: { type: EventType.RUN_ERROR, message },
      });
    };

    let runner: PromptRunner;
    try {
      runner = await deps.runnerFactory();
    } catch (err) {
      emitRunError(err);
      dispatchInternal({ type: "FINALIZE_RUN", runId, status: "errored", endedAt: now() });
      return;
    }
    activeRunner = runner;

    const emit = (msg: JsonRpcMessage): void => {
      // Only `session/update` notifications are bridged. The shim's
      // request/response messages are routed elsewhere and not part of the
      // user-facing trace.
      if (!("method" in msg) || msg.method !== "session/update") return;
      const events = bridge({
        jsonrpc: "2.0",
        method: "session/update",
        params: msg.params,
      });
      for (const ev of events) {
        // Only dispatch into RECEIVE_EVENT if this is still the active run.
        if (state.activeRunId !== runId) return;
        dispatch({ type: "RECEIVE_EVENT", event: ev });
      }
    };

    try {
      await runner.runPrompt({ sessionId, input: prompt }, emit);
      // Only finalize if the run wasn't cancelled mid-flight (the reducer
      // also guards on status === 'running' but we check here too to avoid
      // emitting a no-op notification to subscribers).
      const current = state.runs.get(runId);
      if (current && current.status === "running") {
        dispatchInternal({ type: "FINALIZE_RUN", runId, status: "completed", endedAt: now() });
      }
    } catch (err) {
      const current = state.runs.get(runId);
      if (current && current.status === "running") {
        emitRunError(err);
        dispatchInternal({ type: "FINALIZE_RUN", runId, status: "errored", endedAt: now() });
      }
    } finally {
      if (activeRunner === runner) {
        activeRunner = null;
        activeRunSessionId = null;
      }
    }
  }

  return {
    getState: () => state,
    dispatch,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
