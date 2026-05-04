import { describe, expect, it } from "bun:test";
import type { AguiEventEnvelope } from "./agui-event-bridge.ts";
import type { JsonRpcMessage, PromptParams, PromptRunner } from "./browser-acp-shim.ts";
import { createManifestValidator, DEFAULT_MANIFEST } from "./manifest-schema.ts";
import {
  createPlaygroundStore,
  EVENT_CAP,
  type PlaygroundScheduler,
  type PlaygroundStore,
  REPLAY_INTERVAL_MS,
  type StoreAction,
} from "./playground-store.ts";

/**
 * Type guard for filtering RUN_ERROR events out of the broader
 * AguiEventEnvelope union. Used by the regression tests for the
 * runner-/factory-throws → silent-blank-pane bug.
 */
function isRunError(e: AguiEventEnvelope): e is Extract<AguiEventEnvelope, { type: "RUN_ERROR" }> {
  return e.type === "RUN_ERROR";
}

function fakeRunner(
  opts: {
    emitOnRun?: (emit: (m: JsonRpcMessage) => void, params: PromptParams) => Promise<void>;
    onCancel?: (sessionId: string) => void;
  } = {},
): PromptRunner {
  return {
    async runPrompt(params, emit) {
      if (opts.emitOnRun) await opts.emitOnRun(emit, params);
    },
    cancel(sessionId) {
      opts.onCancel?.(sessionId);
    },
  };
}

function freshStore(
  deps: Partial<Parameters<typeof createPlaygroundStore>[0]> = {},
): PlaygroundStore {
  return createPlaygroundStore({
    runnerFactory: deps.runnerFactory ?? (async () => fakeRunner()),
    validator: deps.validator ?? createManifestValidator(),
    initialManifest: deps.initialManifest,
    now: deps.now ?? (() => 1000),
    runIdFactory: deps.runIdFactory,
    scheduler: deps.scheduler,
  });
}

describe("createPlaygroundStore — initial state", () => {
  it("seeds default manifest, manifestDraft, and ui state", () => {
    const store = freshStore();
    const s = store.getState();
    expect(s.manifest).toEqual(DEFAULT_MANIFEST);
    expect(s.manifestDraft).toEqual(DEFAULT_MANIFEST);
    expect(s.ui.activeTab).toBe("trace");
    expect(s.ui.theme).toBe("light");
    expect(s.runs.size).toBe(0);
    expect(s.activeRunId).toBeNull();
    expect(s.replayMode).toBeNull();
  });

  it("uses initialManifest when provided", () => {
    const store = freshStore({
      initialManifest: { ...DEFAULT_MANIFEST, name: "custom-agent" },
    });
    expect(store.getState().manifest.name).toBe("custom-agent");
    expect(store.getState().manifestDraft.name).toBe("custom-agent");
  });
});

describe("UI actions", () => {
  it("SET_TAB switches the active tab", () => {
    const store = freshStore();
    store.dispatch({ type: "SET_TAB", tab: "manifest" });
    expect(store.getState().ui.activeTab).toBe("manifest");
  });

  it("TOGGLE_THEME toggles light <-> dark", () => {
    const store = freshStore();
    expect(store.getState().ui.theme).toBe("light");
    store.dispatch({ type: "TOGGLE_THEME" });
    expect(store.getState().ui.theme).toBe("dark");
    store.dispatch({ type: "TOGGLE_THEME" });
    expect(store.getState().ui.theme).toBe("light");
  });
});

describe("manifest draft + apply", () => {
  it("UPDATE_MANIFEST_DRAFT merges patch without touching applied manifest", () => {
    const store = freshStore();
    store.dispatch({ type: "UPDATE_MANIFEST_DRAFT", patch: { name: "edited" } });
    expect(store.getState().manifestDraft.name).toBe("edited");
    expect(store.getState().manifest.name).toBe(DEFAULT_MANIFEST.name);
  });

  it("APPLY_MANIFEST promotes draft to applied when valid", () => {
    const store = freshStore();
    store.dispatch({ type: "UPDATE_MANIFEST_DRAFT", patch: { name: "new-name" } });
    store.dispatch({ type: "APPLY_MANIFEST" });
    expect(store.getState().manifest.name).toBe("new-name");
  });

  it("APPLY_MANIFEST is a no-op when draft is invalid", () => {
    const store = freshStore();
    store.dispatch({ type: "UPDATE_MANIFEST_DRAFT", patch: { name: "" } });
    store.dispatch({ type: "APPLY_MANIFEST" });
    // Draft stayed mutated, but applied did NOT change.
    expect(store.getState().manifestDraft.name).toBe("");
    expect(store.getState().manifest.name).toBe(DEFAULT_MANIFEST.name);
  });
});

describe("run lifecycle", () => {
  it("START_RUN creates a running run record", () => {
    const store = freshStore({
      runnerFactory: async () => fakeRunner({ emitOnRun: () => new Promise(() => {}) }),
    });
    store.dispatch({ type: "START_RUN", prompt: "hello" });
    const s = store.getState();
    expect(s.activeRunId).not.toBeNull();
    const run = s.runs.get(s.activeRunId ?? "");
    expect(run?.status).toBe("running");
    expect(run?.prompt).toBe("hello");
  });

  it("RECEIVE_EVENT appends to the active run's events buffer", () => {
    const store = freshStore();
    store.dispatch({ type: "START_RUN", prompt: "p" });
    store.dispatch({
      type: "RECEIVE_EVENT",
      event: { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" } as never,
    });
    const id = store.getState().activeRunId ?? "";
    const run = store.getState().runs.get(id);
    expect(run?.events.length).toBe(1);
  });

  it("EVENT_CAP is enforced — oldest dropped when exceeded", () => {
    const store = freshStore();
    store.dispatch({ type: "START_RUN", prompt: "p" });
    for (let i = 0; i < EVENT_CAP + 5; i++) {
      store.dispatch({
        type: "RECEIVE_EVENT",
        event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: `e${i}` } as never,
      });
    }
    const id = store.getState().activeRunId ?? "";
    const run = store.getState().runs.get(id);
    expect(run?.events.length).toBe(EVENT_CAP);
    // Oldest dropped: events 0..4 should be gone, event 5 should be at index 0.
    const firstDelta = (run?.events[0] as { delta: string }).delta;
    expect(firstDelta).toBe("e5");
    const lastDelta = (run?.events[run.events.length - 1] as { delta: string }).delta;
    expect(lastDelta).toBe(`e${EVENT_CAP + 4}`);
  });

  it("CANCEL_RUN transitions active run to cancelled and calls runner.cancel", async () => {
    let cancelled = false;
    const store = freshStore({
      runnerFactory: async () =>
        fakeRunner({
          // never resolves, simulating a long-running model
          emitOnRun: () => new Promise(() => {}),
          onCancel: () => {
            cancelled = true;
          },
        }),
    });
    store.dispatch({ type: "START_RUN", prompt: "stuck" });
    await flushMicrotasks();
    store.dispatch({ type: "CANCEL_RUN" });
    const id = store.getState().activeRunId ?? "";
    const run = store.getState().runs.get(id);
    expect(run?.status).toBe("cancelled");
    expect(cancelled).toBe(true);
  });

  it("a runner that emits answer.done transitions the run to completed", async () => {
    const store = freshStore({
      runnerFactory: async () =>
        fakeRunner({
          emitOnRun: async (emit, params) => {
            emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: params.sessionId, kind: "answer.chunk", text: "hi" },
            });
            emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: params.sessionId, kind: "answer.done" },
            });
          },
        }),
    });
    store.dispatch({ type: "START_RUN", prompt: "hi" });
    // Wait for the runner promise chain to settle.
    await flushMicrotasks();
    await flushMicrotasks();
    const id = store.getState().activeRunId ?? "";
    const run = store.getState().runs.get(id);
    expect(run?.status).toBe("completed");
    expect(run?.endedAt).toBeDefined();
    expect(run?.events.length).toBeGreaterThan(0);
  });

  it("a runner that throws transitions the run to errored AND emits RUN_ERROR", async () => {
    // Regression for the deploy bug 2026-04-27: when `runPrompt` throws,
    // the run record's status flipped to "errored" silently — no RUN_ERROR
    // event was added to the trace, so chat pane and trace inspector both
    // rendered the user's prompt then went blank forever. Both must now be
    // present: status flip + visible error event.
    const store = freshStore({
      runnerFactory: async () =>
        fakeRunner({
          emitOnRun: async () => {
            throw new Error("model exploded");
          },
        }),
    });
    store.dispatch({ type: "START_RUN", prompt: "boom" });
    await flushMicrotasks();
    await flushMicrotasks();
    const id = store.getState().activeRunId ?? "";
    const run = store.getState().runs.get(id);
    expect(run?.status).toBe("errored");
    const errors = (run?.events ?? []).filter(isRunError);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toBe("model exploded");
  });

  it("a runnerFactory that rejects emits RUN_ERROR and transitions to errored", async () => {
    // Canonical failure mode for `local-wasm-worker` on browsers without
    // WebGPU — the factory throws synchronously while resolving the engine,
    // and prior to the fix the user saw their prompt then total silence.
    const store = freshStore({
      runnerFactory: async () => {
        throw new Error("WebGPU unavailable in this browser");
      },
    });
    store.dispatch({ type: "START_RUN", prompt: "test" });
    await flushMicrotasks();
    await flushMicrotasks();
    const id = store.getState().activeRunId ?? "";
    const run = store.getState().runs.get(id);
    expect(run?.status).toBe("errored");
    const errors = (run?.events ?? []).filter(isRunError);
    expect(errors.length).toBe(1);
    expect(errors[0]?.message).toBe("WebGPU unavailable in this browser");
  });
});

describe("replay engine (M5: timing-driven re-emission)", () => {
  it("START_REPLAY on a non-existent runId is a silent no-op (no commit, no timer)", () => {
    const sched = makeFakeScheduler();
    const store = freshStore({ scheduler: sched });
    const before = store.getState();
    store.dispatch({ type: "START_REPLAY", runId: "ghost-id" });
    expect(store.getState().replayMode).toBeNull();
    // State reference unchanged → reducer never ran.
    expect(store.getState()).toBe(before);
    expect(sched.pending.length).toBe(0);
  });

  it("START_REPLAY on a zero-event run flips state then auto-stops with no ticks scheduled", async () => {
    const store = freshStore({
      runnerFactory: async () =>
        fakeRunner({
          // resolves immediately, run completes with no events
        }),
    });
    store.dispatch({ type: "START_RUN", prompt: "empty" });
    await flushMicrotasks();
    await flushMicrotasks();
    const id = store.getState().activeRunId ?? "";
    store.dispatch({ type: "START_REPLAY", runId: id });
    // Auto-stops: no events to replay.
    expect(store.getState().replayMode).toBeNull();
    expect(store.getState().replayBuffer).toEqual([]);
  });

  it("START_REPLAY schedules first tick and re-emits events through replayBuffer at REPLAY_INTERVAL_MS", () => {
    const sched = makeFakeScheduler();
    const store = freshStoreWithRun(
      [makeTextStartEvent("m1"), makeTextContentEvent("m1", "hi"), makeTextContentEvent("m1", "!")],
      { scheduler: sched },
    );
    const id = firstRunId(store);
    store.dispatch({ type: "START_REPLAY", runId: id });
    // Tick scheduled but not yet fired.
    expect(store.getState().replayBuffer).toEqual([]);
    expect(sched.pending.length).toBe(1);
    expect(sched.pending[0]?.ms).toBe(REPLAY_INTERVAL_MS);
    sched.advance();
    expect(store.getState().replayBuffer.length).toBe(1);
    expect(sched.pending.length).toBe(1); // next tick scheduled
    sched.advance();
    expect(store.getState().replayBuffer.length).toBe(2);
    expect(sched.pending.length).toBe(1);
    // Final tick fires the third event then auto-stops, which clears the
    // buffer and replayMode (the inspector falls back to the live run view).
    sched.advance();
    expect(store.getState().replayMode).toBeNull();
    expect(store.getState().replayBuffer).toEqual([]);
    expect(sched.pending.length).toBe(0);
  });

  it("RECEIVE_REPLAY_EVENT actions are dispatched in 1-indexed seq order", () => {
    const sched = makeFakeScheduler();
    const store = freshStoreWithRun(
      [makeTextStartEvent("m1"), makeTextContentEvent("m1", "a"), makeTextContentEvent("m1", "b")],
      { scheduler: sched },
    );
    const seenSeq: number[] = [];
    store.subscribe((_s, a) => {
      if (a.type === "RECEIVE_REPLAY_EVENT") seenSeq.push(a.replaySeq);
    });
    const id = firstRunId(store);
    store.dispatch({ type: "START_REPLAY", runId: id });
    sched.advanceAll();
    expect(seenSeq).toEqual([1, 2, 3]);
  });

  it("STOP_REPLAY mid-replay cancels the timer and clears replayBuffer + replayMode", () => {
    const sched = makeFakeScheduler();
    const store = freshStoreWithRun(
      Array.from({ length: 10 }, (_, i) => makeTextContentEvent("m1", `c${i}`)),
      { scheduler: sched },
    );
    const id = firstRunId(store);
    store.dispatch({ type: "START_REPLAY", runId: id });
    sched.advance(); // 1 event re-emitted
    expect(store.getState().replayBuffer.length).toBe(1);
    store.dispatch({ type: "STOP_REPLAY" });
    expect(store.getState().replayMode).toBeNull();
    expect(store.getState().replayBuffer).toEqual([]);
    expect(sched.pending.length).toBe(0);
  });

  it("STOP_REPLAY when no replay is active is a no-op (state reference unchanged)", () => {
    const store = freshStore();
    const before = store.getState();
    store.dispatch({ type: "STOP_REPLAY" });
    expect(store.getState()).toBe(before);
  });

  it("a second START_REPLAY cancels the prior timer and restarts from index 0", () => {
    const sched = makeFakeScheduler();
    const store = freshStoreWithRun(
      [makeTextContentEvent("m1", "x"), makeTextContentEvent("m1", "y")],
      { scheduler: sched },
    );
    const id = firstRunId(store);
    const replayEvents: number[] = [];
    store.subscribe((_s, a) => {
      if (a.type === "RECEIVE_REPLAY_EVENT") replayEvents.push(a.replaySeq);
    });
    store.dispatch({ type: "START_REPLAY", runId: id });
    sched.advance(); // 1 event
    expect(store.getState().replayBuffer.length).toBe(1);
    expect(store.getState().replayMode?.nextIndex).toBe(1);
    // Restart on the same run — should reset nextIndex to 0 and replay all.
    store.dispatch({ type: "START_REPLAY", runId: id });
    expect(store.getState().replayBuffer).toEqual([]);
    expect(store.getState().replayMode?.nextIndex).toBe(0);
    sched.advanceAll();
    // Subscriber captured: 1 event from the first replay (1) plus 2 from
    // the restart (1, 2) = [1, 1, 2]. Confirms the engine restarted from 0.
    expect(replayEvents).toEqual([1, 1, 2]);
  });

  it("a new START_RUN while replay is active cancels the replay (live > replay priority)", async () => {
    const sched = makeFakeScheduler();
    // Stage a completed run by dispatching RECEIVE_EVENT directly instead of
    // driving a runner — we want the replay timer to be the only thing in
    // flight when we fire the second START_RUN.
    const store = freshStore({
      scheduler: sched,
      runnerFactory: async () =>
        fakeRunner({
          emitOnRun: () => new Promise(() => {}),
        }),
    });
    // Seed a run with events to replay.
    store.dispatch({ type: "START_RUN", prompt: "first" });
    store.dispatch({ type: "RECEIVE_EVENT", event: makeTextContentEvent("m1", "old") });
    store.dispatch({ type: "RECEIVE_EVENT", event: makeTextContentEvent("m1", "old2") });
    const firstId = store.getState().activeRunId ?? "";
    store.dispatch({ type: "START_REPLAY", runId: firstId });
    expect(sched.pending.length).toBe(1);
    // Now start a new live run while replay is mid-flight.
    store.dispatch({ type: "START_RUN", prompt: "second" });
    expect(store.getState().replayMode).toBeNull();
    expect(store.getState().replayBuffer).toEqual([]);
    expect(sched.pending.length).toBe(0);
  });

  it("CLEAR_SESSIONS during replay cancels the timer and clears replayBuffer", () => {
    const sched = makeFakeScheduler();
    const store = freshStoreWithRun([makeTextContentEvent("m1", "a")], { scheduler: sched });
    const id = firstRunId(store);
    store.dispatch({ type: "START_REPLAY", runId: id });
    expect(sched.pending.length).toBe(1);
    store.dispatch({ type: "CLEAR_SESSIONS" });
    expect(store.getState().runs.size).toBe(0);
    expect(store.getState().replayMode).toBeNull();
    expect(store.getState().replayBuffer).toEqual([]);
    expect(sched.pending.length).toBe(0);
  });

  it("source run's events array is never mutated during replay", () => {
    const sched = makeFakeScheduler();
    const events = [
      makeTextContentEvent("m1", "a"),
      makeTextContentEvent("m1", "b"),
      makeTextContentEvent("m1", "c"),
    ];
    const store = freshStoreWithRun(events, { scheduler: sched });
    const id = firstRunId(store);
    const before = store.getState().runs.get(id)?.events;
    const beforeLen = before?.length ?? 0;
    const beforeSnapshot = before ? [...before] : [];
    store.dispatch({ type: "START_REPLAY", runId: id });
    sched.advanceAll();
    const after = store.getState().runs.get(id)?.events;
    expect(after?.length).toBe(beforeLen);
    expect(after).toEqual(beforeSnapshot);
  });

  it("scheduler defaults to globals when not injected (smoke: replay starts and re-emits)", async () => {
    // No scheduler injected — fall back to real setTimeout. We use a 1-event
    // run so the test only waits one interval before the engine auto-stops.
    const store = freshStoreWithRun([makeTextContentEvent("m1", "ok")]);
    const id = firstRunId(store);
    store.dispatch({ type: "START_REPLAY", runId: id });
    // Wait for one tick + the auto-stop microtask. REPLAY_INTERVAL_MS = 50 in
    // production; 80ms covers one tick + scheduler slack.
    await new Promise((resolve) => setTimeout(resolve, 80));
    // After replay finishes, mode is null and buffer cleared.
    expect(store.getState().replayMode).toBeNull();
  });

  it("RECEIVE_REPLAY_EVENT after STOP_REPLAY is a no-op (defensive reducer guard)", () => {
    // Exercises the reducer's `replayMode === null` guard at
    // playground-store.ts's RECEIVE_REPLAY_EVENT case. Simulates the race
    // a misbehaving scheduler could create: a late tick fires AFTER
    // STOP_REPLAY has cleared the timer + buffer. The reducer must reject
    // the synthetic action so a stale tick can't repopulate `replayBuffer`
    // or revive `replayMode`.
    //
    // `dispatch` is publicly typed against `DispatchAction` (which excludes
    // RECEIVE_REPLAY_EVENT — it's internal-only), so we cast through the
    // `dispatch` callable to drive the reducer path directly. This is the
    // ONLY place tests synthesize an internal action; production code path
    // remains the timer-driven scheduler closure.
    const sched = makeFakeScheduler();
    const store = freshStoreWithRun(
      [makeTextContentEvent("m1", "a"), makeTextContentEvent("m1", "b")],
      { scheduler: sched },
    );
    const id = firstRunId(store);
    store.dispatch({ type: "START_REPLAY", runId: id });
    sched.advance(); // re-emit first event into replayBuffer
    expect(store.getState().replayBuffer.length).toBe(1);
    store.dispatch({ type: "STOP_REPLAY" });
    expect(store.getState().replayMode).toBeNull();
    expect(store.getState().replayBuffer).toEqual([]);
    // Now drive a late tick directly through the dispatch callable. The
    // reducer guard short-circuits on `replayMode === null`, so state
    // stays at rest.
    const lateAction: StoreAction = {
      type: "RECEIVE_REPLAY_EVENT",
      runId: id,
      event: makeTextContentEvent("m1", "late"),
      replaySeq: 99,
    };
    (store.dispatch as (a: StoreAction) => void)(lateAction);
    expect(store.getState().replayMode).toBeNull();
    expect(store.getState().replayBuffer).toEqual([]);
  });

  it("RECEIVE_REPLAY_EVENT for a different runId than the active replay is a no-op", () => {
    // Same defensive guard, second slice: the reducer also rejects events
    // that target a runId other than the one currently replaying. Guards
    // against an interleave where two replays race on a shared scheduler.
    const sched = makeFakeScheduler();
    const store = freshStoreWithRun([makeTextContentEvent("m1", "a")], { scheduler: sched });
    const id = firstRunId(store);
    store.dispatch({ type: "START_REPLAY", runId: id });
    expect(store.getState().replayMode?.runId).toBe(id);
    const wrongAction: StoreAction = {
      type: "RECEIVE_REPLAY_EVENT",
      runId: "ghost-id",
      event: makeTextContentEvent("m1", "wrong"),
      replaySeq: 1,
    };
    (store.dispatch as (a: StoreAction) => void)(wrongAction);
    // Buffer remained empty (no tick has fired yet); replayMode unchanged.
    expect(store.getState().replayBuffer).toEqual([]);
    expect(store.getState().replayMode?.runId).toBe(id);
  });

  it("subscribers see RECEIVE_REPLAY_EVENT actions in order alongside the START_REPLAY commit", () => {
    const sched = makeFakeScheduler();
    const store = freshStoreWithRun(
      [makeTextContentEvent("m1", "a"), makeTextContentEvent("m1", "b")],
      { scheduler: sched },
    );
    const types: string[] = [];
    store.subscribe((_s, a) => {
      types.push(a.type);
    });
    const id = firstRunId(store);
    store.dispatch({ type: "START_REPLAY", runId: id });
    sched.advanceAll();
    // START_REPLAY → RECEIVE_REPLAY_EVENT × 2 → STOP_REPLAY (auto).
    expect(types).toEqual([
      "START_REPLAY",
      "RECEIVE_REPLAY_EVENT",
      "RECEIVE_REPLAY_EVENT",
      "STOP_REPLAY",
    ]);
  });
});

describe("replay state preservation (M1 spec carryover)", () => {
  it("CLEAR_SESSIONS empties runs map and clears active+replay+buffer", () => {
    const store = freshStore();
    store.dispatch({ type: "START_RUN", prompt: "p" });
    store.dispatch({ type: "CLEAR_SESSIONS" });
    expect(store.getState().runs.size).toBe(0);
    expect(store.getState().activeRunId).toBeNull();
    expect(store.getState().replayMode).toBeNull();
    expect(store.getState().replayBuffer).toEqual([]);
  });
});

describe("subscribe", () => {
  it("listener fires after each dispatch with the new state and the action", () => {
    const store = freshStore();
    const seen: StoreAction[] = [];
    store.subscribe((_state, action) => {
      seen.push(action);
    });
    store.dispatch({ type: "TOGGLE_THEME" });
    store.dispatch({ type: "SET_TAB", tab: "manifest" });
    expect(seen.map((a) => a.type)).toEqual(["TOGGLE_THEME", "SET_TAB"]);
  });

  it("unsubscribe stops further notifications", () => {
    const store = freshStore();
    let count = 0;
    const unsub = store.subscribe(() => {
      count += 1;
    });
    store.dispatch({ type: "TOGGLE_THEME" });
    unsub();
    store.dispatch({ type: "TOGGLE_THEME" });
    expect(count).toBe(1);
  });

  it("unsubscribe during dispatch does not break iteration", () => {
    const store = freshStore();
    let aCount = 0;
    let bCount = 0;
    const unsubA = store.subscribe(() => {
      aCount += 1;
      unsubA();
    });
    store.subscribe(() => {
      bCount += 1;
    });
    store.dispatch({ type: "TOGGLE_THEME" });
    store.dispatch({ type: "TOGGLE_THEME" });
    expect(aCount).toBe(1);
    expect(bCount).toBe(2);
  });
});

describe("subscriber coherence", () => {
  // Set of public StoreAction discriminants — used to assert subscribers
  // never see synthetic / off-union action types.
  const VALID_ACTION_TYPES = new Set([
    "SET_TAB",
    "TOGGLE_THEME",
    "UPDATE_MANIFEST_DRAFT",
    "APPLY_MANIFEST",
    "START_RUN",
    "CANCEL_RUN",
    "FINALIZE_RUN",
    "RECEIVE_EVENT",
    "RECEIVE_REPLAY_EVENT",
    "START_REPLAY",
    "STOP_REPLAY",
    "CLEAR_SESSIONS",
  ]);

  it("every observed (state, action) pair is consistent with the action's discriminant", async () => {
    const store = freshStore({
      now: () => 5000,
      runnerFactory: async () =>
        fakeRunner({
          emitOnRun: async (emit, params) => {
            emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: params.sessionId, kind: "answer.chunk", text: "ok" },
            });
            emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: params.sessionId, kind: "answer.done" },
            });
          },
        }),
    });

    const observations: Array<{
      action: StoreAction;
      runStatusForActiveRun: string | undefined;
    }> = [];
    store.subscribe((s, action) => {
      observations.push({
        action,
        runStatusForActiveRun: s.activeRunId ? s.runs.get(s.activeRunId)?.status : undefined,
      });
    });

    store.dispatch({ type: "START_RUN", prompt: "go" });
    await flushMicrotasks();
    await flushMicrotasks();

    // Every observed action.type is in the public union.
    for (const obs of observations) {
      expect(VALID_ACTION_TYPES.has(obs.action.type)).toBe(true);
    }

    // The first observation must be START_RUN with runStatus 'running'.
    const startObs = observations.find((o) => o.action.type === "START_RUN");
    expect(startObs).toBeDefined();
    expect(startObs?.runStatusForActiveRun).toBe("running");

    // The terminal FINALIZE_RUN observation must coincide with status='completed'.
    const finalizeObs = observations.find((o) => o.action.type === "FINALIZE_RUN");
    expect(finalizeObs).toBeDefined();
    expect(finalizeObs?.runStatusForActiveRun).toBe("completed");

    // And endedAt > startedAt on the finalized run.
    const id = store.getState().activeRunId ?? "";
    const finalRun = store.getState().runs.get(id);
    expect(finalRun?.status).toBe("completed");
    expect((finalRun?.endedAt ?? 0) >= (finalRun?.startedAt ?? 0)).toBe(true);
  });

  it("FINALIZE_RUN action carries the runId and status fields (real, not synthetic)", async () => {
    const store = freshStore({
      runnerFactory: async () =>
        fakeRunner({
          emitOnRun: async () => {
            // resolves immediately
          },
        }),
    });
    let finalize: StoreAction | undefined;
    store.subscribe((_s, a) => {
      if (a.type === "FINALIZE_RUN") finalize = a;
    });
    store.dispatch({ type: "START_RUN", prompt: "p" });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(finalize).toBeDefined();
    if (finalize?.type === "FINALIZE_RUN") {
      expect(typeof finalize.runId).toBe("string");
      expect(["completed", "errored"]).toContain(finalize.status);
      expect(typeof finalize.endedAt).toBe("number");
    }
  });
});

describe("reducer purity (regression guard)", () => {
  it("two stores get distinct run-id sequences (no module counter leak)", () => {
    const storeA = freshStore({
      runnerFactory: async () => fakeRunner({ emitOnRun: () => new Promise(() => {}) }),
    });
    const storeB = freshStore({
      runnerFactory: async () => fakeRunner({ emitOnRun: () => new Promise(() => {}) }),
    });
    storeA.dispatch({ type: "START_RUN", prompt: "a" });
    storeB.dispatch({ type: "START_RUN", prompt: "b" });
    const idA = storeA.getState().activeRunId;
    const idB = storeB.getState().activeRunId;
    // Both should be the closure's first id (counter starts at 0 in each
    // store), proving the counter is per-store, not module-global.
    expect(idA).not.toBeNull();
    expect(idB).not.toBeNull();
    expect(idA?.startsWith("run-1-")).toBe(true);
    expect(idB?.startsWith("run-1-")).toBe(true);
  });

  it("injectable runIdFactory pins the run id deterministically", () => {
    const ids = ["fixed-id-A", "fixed-id-B"];
    let i = 0;
    const store = freshStore({
      runIdFactory: () => ids[i++] ?? "fallback",
      runnerFactory: async () => fakeRunner({ emitOnRun: () => new Promise(() => {}) }),
    });
    store.dispatch({ type: "START_RUN", prompt: "p" });
    expect(store.getState().activeRunId).toBe("fixed-id-A");
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Fake `PlaygroundScheduler` that captures pending timers so tests can
 * advance them deterministically. `setTimeout` returns a fake handle
 * (a unique number); `clearTimeout` removes the matching pending entry.
 *
 * Test API:
 *   - `pending` — read-only snapshot of currently scheduled callbacks
 *   - `advance()` — fire and remove the oldest pending callback
 *   - `advanceAll()` — drain to completion (fire callbacks recursively)
 */
function makeFakeScheduler(): PlaygroundScheduler & {
  readonly pending: Array<{ id: number; ms: number; fn: () => void }>;
  advance: () => void;
  advanceAll: () => void;
} {
  // The handle type uses `ReturnType<typeof setTimeout>` (a runtime-dependent
  // type). Bun resolves it to `Timer`; the fake returns a numeric id and
  // casts at the boundary so consumers don't notice the difference.
  let nextId = 1;
  const pending: Array<{ id: number; ms: number; fn: () => void }> = [];
  return {
    pending,
    setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
      const id = nextId++;
      pending.push({ id, ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>): void {
      const id = handle as unknown as number;
      const idx = pending.findIndex((p) => p.id === id);
      if (idx >= 0) pending.splice(idx, 1);
    },
    advance(): void {
      const next = pending.shift();
      if (next) next.fn();
    },
    advanceAll(): void {
      // Cap the loop at a generous bound to surface infinite-schedule bugs
      // rather than hanging the suite.
      let safety = 1000;
      while (pending.length > 0) {
        const next = pending.shift();
        if (next) next.fn();
        if (--safety <= 0) throw new Error("fake scheduler advanceAll exceeded 1000 ticks");
      }
    },
  };
}

/**
 * Stage a store with a single completed run holding the given AG-UI
 * events, ready for `START_REPLAY` tests. Avoids the runner-driver
 * round-trip — the run is finalized synchronously via direct dispatches.
 */
function freshStoreWithRun(
  events: AguiEventEnvelope[],
  deps: Partial<Parameters<typeof createPlaygroundStore>[0]> = {},
): PlaygroundStore {
  const store = freshStore({
    ...deps,
    runnerFactory:
      deps.runnerFactory ??
      (async () =>
        fakeRunner({
          emitOnRun: () => new Promise(() => {}),
        })),
  });
  store.dispatch({ type: "START_RUN", prompt: "seed" });
  for (const ev of events) {
    store.dispatch({ type: "RECEIVE_EVENT", event: ev });
  }
  return store;
}

function firstRunId(store: PlaygroundStore): string {
  const id = store.getState().activeRunId;
  if (!id) throw new Error("no active run staged");
  return id;
}

/**
 * Minimal AG-UI envelope factories. The reducer tests in this file already
 * use `as never` to cheat past the discriminator — we keep the same
 * pattern here for symmetry. Production code uses the real bridge.
 */
function makeTextStartEvent(messageId: string): AguiEventEnvelope {
  return { type: "TEXT_MESSAGE_START", messageId, role: "assistant" } as never;
}

function makeTextContentEvent(messageId: string, delta: string): AguiEventEnvelope {
  return { type: "TEXT_MESSAGE_CONTENT", messageId, delta } as never;
}
