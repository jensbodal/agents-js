/**
 * Element-level tests for `<docs-playground-shell>`.
 *
 * Covers the dispatch-translation seams the shell adds on top of the store:
 * child events → store actions, capability detection → store bootstrap,
 * activation → cached-runner construction. Renders are exercised
 * via the pure-helper extractions where possible; the shell instance is
 * staged via `Object.create` since Bun's test runtime has no DOM.
 */
import { describe, expect, test } from "bun:test";
import type {
  BrowserCapabilities,
  JsonRpcMessage,
  ManifestDraft,
  PlaygroundStore,
  PromptParams,
  PromptRunner,
} from "@agents-js/browser-runtime";
import { DocsPlaygroundShell } from "./docs-playground-shell.ts";

function instance(): DocsPlaygroundShell {
  return Object.create(DocsPlaygroundShell.prototype) as DocsPlaygroundShell;
}

function fakeRunner(
  opts: {
    onRun?: (emit: (m: JsonRpcMessage) => void, params: PromptParams) => Promise<void> | void;
    onCancel?: (sessionId: string) => void;
  } = {},
): PromptRunner {
  return {
    async runPrompt(params, emit) {
      if (opts.onRun) await opts.onRun(emit, params);
    },
    cancel(sessionId) {
      opts.onCancel?.(sessionId);
    },
  };
}

const NO_WEBGPU_CAPS: BrowserCapabilities = {
  webgpu: false,
  secureContext: true,
  adapterFeatures: [],
  deviceMemoryGB: 8,
};
const WEBGPU_CAPS: BrowserCapabilities = {
  webgpu: true,
  secureContext: true,
  adapterFeatures: ["shader-f16"],
  deviceMemoryGB: 8,
};

describe("DocsPlaygroundShell — class shape", () => {
  test("class exists and is a function", () => {
    expect(typeof DocsPlaygroundShell).toBe("function");
  });

  test("exposes runnerFactory, mockRunnerFactory, capabilitiesProbe as reactive props", () => {
    const props = DocsPlaygroundShell.elementProperties;
    expect(props.get("runnerFactory")).toBeDefined();
    expect(props.get("mockRunnerFactory")).toBeDefined();
    expect(props.get("capabilitiesProbe")).toBeDefined();
  });

  test("registers as 'docs-playground-shell' on import", () => {
    if (typeof customElements !== "undefined") {
      expect(customElements.get("docs-playground-shell")).toBeDefined();
    } else {
      expect(typeof DocsPlaygroundShell).toBe("function");
    }
  });
});

describe("DocsPlaygroundShell — capability detection on connectedCallback", () => {
  test("model id is set + manifest defaults to local-wasm-worker when WebGPU is available", async () => {
    const inst = instance();
    Object.defineProperty(inst, "capabilitiesProbe", {
      value: async () => WEBGPU_CAPS,
      writable: true,
    });
    Object.defineProperty(inst, "_phase", { value: "detecting", writable: true });
    Object.defineProperty(inst, "_modelId", { value: null, writable: true });
    Object.defineProperty(inst, "_state", { value: null, writable: true });
    Object.defineProperty(inst, "_store", { value: null, writable: true });
    Object.defineProperty(inst, "_unsubscribe", { value: null, writable: true });
    // Invoke the production prototype method directly so the test exercises
    // real shell behavior (capability probe → chooseModel → store bootstrap),
    // not a re-implementation. `_detectCapabilities` is the production seam
    // factored out of `connectedCallback` so we can sidestep
    // `super.connectedCallback()` (which would touch `document`).
    await (
      DocsPlaygroundShell.prototype as unknown as { _detectCapabilities: () => Promise<void> }
    )._detectCapabilities.call(inst);
    expect(inst.__phase).toBe("ready-to-activate");
    expect(getInternal(inst, "_modelId")).not.toBeNull();
    expect(inst.__store).not.toBeNull();
    // Default pre-activation manifest = local-wasm-worker when WebGPU is
    // available (matches the legacy mode-picker default).
    expect(inst.__store?.getState().manifest.runtime).toBe("local-wasm-worker");
  });

  test("falls back to mock runtime in the manifest when WebGPU is unavailable", async () => {
    const inst = instance();
    Object.defineProperty(inst, "capabilitiesProbe", {
      value: async () => NO_WEBGPU_CAPS,
      writable: true,
    });
    Object.defineProperty(inst, "_phase", { value: "detecting", writable: true });
    Object.defineProperty(inst, "_modelId", { value: null, writable: true });
    Object.defineProperty(inst, "_state", { value: null, writable: true });
    Object.defineProperty(inst, "_store", { value: null, writable: true });
    Object.defineProperty(inst, "_unsubscribe", { value: null, writable: true });
    await (
      DocsPlaygroundShell.prototype as unknown as { _detectCapabilities: () => Promise<void> }
    )._detectCapabilities.call(inst);
    expect(inst.__phase).toBe("ready-to-activate");
    expect(getInternal(inst, "_modelId")).toBeNull();
    // No-WebGPU host defaults the manifest to mock so the user can activate
    // without having to manually flip the runtime selector first.
    expect(inst.__store?.getState().manifest.runtime).toBe("mock");
  });
});

describe("DocsPlaygroundShell — render", () => {
  test("renders <docs-manifest-editor> in the ready-to-activate phase (pre-activation editor)", () => {
    const inst = instance();
    stagePhase(inst, "ready-to-activate");
    const result = renderShell(inst);
    expect(collectAllStrings(result)).toContain("docs-manifest-editor");
  });

  test("renders <docs-chat-pane> in the active phase", () => {
    const inst = instance();
    stagePhase(inst, "active");
    Object.defineProperty(inst, "_state", {
      value: { runs: new Map(), activeRunId: null, ui: { activeTab: "trace", theme: "light" } },
      writable: true,
    });
    const result = renderShell(inst);
    expect(collectAllStrings(result)).toContain("docs-chat-pane");
  });

  test("renders <docs-trace-inspector> in the active phase when activeTab === 'trace'", () => {
    const inst = instance();
    stagePhase(inst, "active");
    Object.defineProperty(inst, "_state", {
      value: { runs: new Map(), activeRunId: null, ui: { activeTab: "trace", theme: "light" } },
      writable: true,
    });
    const result = renderShell(inst);
    expect(collectAllStrings(result)).toContain("docs-trace-inspector");
  });

  test("renders <docs-manifest-editor> inside the tabbed inspector when activeTab === 'manifest'", () => {
    const inst = instance();
    stagePhase(inst, "active");
    Object.defineProperty(inst, "_state", {
      value: { runs: new Map(), activeRunId: null, ui: { activeTab: "manifest", theme: "light" } },
      writable: true,
    });
    const result = renderShell(inst);
    const flat = collectAllStrings(result);
    expect(flat).toContain("docs-manifest-editor");
    // Trace inspector is hidden behind the inactive tab — must not render.
    expect(flat).not.toContain("docs-trace-inspector");
  });

  test("renders both Trace and Manifest tab buttons in the active phase", () => {
    const inst = instance();
    stagePhase(inst, "active");
    Object.defineProperty(inst, "_state", {
      value: { runs: new Map(), activeRunId: null, ui: { activeTab: "trace", theme: "light" } },
      writable: true,
    });
    const result = renderShell(inst);
    const flat = collectAllStrings(result);
    expect(flat).toContain("Trace");
    expect(flat).toContain("Manifest");
    expect(flat).toContain("tab-buttons");
  });

  test("does NOT render <docs-chat-pane> outside the active phase", () => {
    const inst = instance();
    stagePhase(inst, "ready-to-activate");
    const result = renderShell(inst);
    expect(collectAllStrings(result)).not.toContain("docs-chat-pane");
  });

  test("active-phase inspector wires ARIA tablist/tab/tabpanel relationships", () => {
    // Tab `<button>`s declare aria-controls + id; the panel wrapper declares
    // role="tabpanel" + aria-labelledby. Screen readers
    // need the round-trip wiring to navigate the tab/panel relationship
    // programmatically. We assert against the static template strings
    // since the attribute names land there even when their values are
    // interpolated.
    const inst = instance();
    stagePhase(inst, "active");
    Object.defineProperty(inst, "_state", {
      value: { runs: new Map(), activeRunId: null, ui: { activeTab: "trace", theme: "light" } },
      writable: true,
    });
    const result = renderShell(inst);
    const flat = collectAllStrings(result);
    // Tab buttons carry the aria-controls + id attrs.
    expect(flat).toContain('aria-controls="panel-trace"');
    expect(flat).toContain('aria-controls="panel-manifest"');
    expect(flat).toContain('id="tab-trace"');
    expect(flat).toContain('id="tab-manifest"');
    // The active panel wrapper carries role="tabpanel" + aria-labelledby.
    expect(flat).toContain('role="tabpanel"');
    expect(flat).toContain("aria-labelledby");
    // The tablist itself carries an aria-label so SR users hear the group
    // name when they focus into it.
    expect(flat).toContain('aria-label="Inspector tabs"');
  });
});

describe("DocsPlaygroundShell — event translation", () => {
  test("setError flips phase to 'error' and surfaces message", () => {
    const inst = instance();
    Object.defineProperty(inst, "_phase", { value: "ready-to-activate", writable: true });
    Object.defineProperty(inst, "_errorText", { value: "", writable: true });
    inst.setError("boom");
    expect(inst.__phase).toBe("error");
    expect(inst.__errorText).toBe("boom");
  });

  test("playground-prompt event dispatch translates to store START_RUN", () => {
    const inst = instance();
    const seenActions: Array<{ type: string }> = [];
    const fakeStore: Pick<PlaygroundStore, "dispatch"> = {
      dispatch: (action) => {
        seenActions.push(action);
      },
    };
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    const handler = (inst as unknown as { _onPrompt: (e: CustomEvent<{ prompt: string }>) => void })
      ._onPrompt;
    handler.call(inst, new CustomEvent("playground-prompt", { detail: { prompt: "hi" } }));
    expect(seenActions.length).toBe(1);
    expect(seenActions[0]?.type).toBe("START_RUN");
  });

  test("playground-cancel event dispatch translates to store CANCEL_RUN", () => {
    const inst = instance();
    const seenActions: Array<{ type: string }> = [];
    const fakeStore: Pick<PlaygroundStore, "dispatch"> = {
      dispatch: (action) => {
        seenActions.push(action);
      },
    };
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    const handler = (inst as unknown as { _onCancel: () => void })._onCancel;
    handler.call(inst);
    expect(seenActions.length).toBe(1);
    expect(seenActions[0]?.type).toBe("CANCEL_RUN");
  });

  test("playground-manifest-edit event translates to store UPDATE_MANIFEST_DRAFT", () => {
    const inst = instance();
    const seenActions: Array<{ type: string; patch?: Partial<ManifestDraft> }> = [];
    const fakeStore: Pick<PlaygroundStore, "dispatch"> = {
      dispatch: (action) => {
        seenActions.push(action);
      },
    };
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    const handler = (
      inst as unknown as {
        _onManifestEdit: (e: CustomEvent<{ patch: Partial<ManifestDraft> }>) => void;
      }
    )._onManifestEdit;
    handler.call(
      inst,
      new CustomEvent("playground-manifest-edit", { detail: { patch: { runtime: "mock" } } }),
    );
    expect(seenActions.length).toBe(1);
    expect(seenActions[0]?.type).toBe("UPDATE_MANIFEST_DRAFT");
    expect(seenActions[0]?.patch).toEqual({ runtime: "mock" });
  });

  test("playground-manifest-apply event translates to store APPLY_MANIFEST", () => {
    const inst = instance();
    const seenActions: Array<{ type: string }> = [];
    const fakeStore: Pick<PlaygroundStore, "dispatch"> = {
      dispatch: (action) => {
        seenActions.push(action);
      },
    };
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    const handler = (inst as unknown as { _onManifestApply: () => void })._onManifestApply;
    handler.call(inst);
    expect(seenActions.length).toBe(1);
    expect(seenActions[0]?.type).toBe("APPLY_MANIFEST");
  });

  test("playground-replay event translates to store START_REPLAY with last run id", () => {
    const inst = instance();
    const seenActions: Array<{ type: string; runId?: string }> = [];
    const fakeStore = {
      dispatch: (action: { type: string; runId?: string }) => {
        seenActions.push(action);
      },
      getState: () => ({
        ui: { activeTab: "trace" as const, theme: "light" as const },
        manifest: {
          name: "x",
          runtime: "mock" as const,
          permissions: "explicit" as const,
          tools: [],
        },
        manifestDraft: {
          name: "x",
          runtime: "mock" as const,
          permissions: "explicit" as const,
          tools: [],
        },
        runs: new Map([
          [
            "run-1",
            { id: "run-1", prompt: "p1", startedAt: 0, status: "completed" as const, events: [] },
          ],
          [
            "run-2",
            { id: "run-2", prompt: "p2", startedAt: 0, status: "completed" as const, events: [] },
          ],
        ]),
        activeRunId: "run-2",
        replayMode: null,
        replayBuffer: [],
      }),
    };
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    const handler = (inst as unknown as { _onReplay: () => void })._onReplay;
    handler.call(inst);
    expect(seenActions.length).toBe(1);
    expect(seenActions[0]?.type).toBe("START_REPLAY");
    expect(seenActions[0]?.runId).toBe("run-2");
  });

  test("playground-replay is a no-op when there are no past runs", () => {
    const inst = instance();
    const seenActions: Array<{ type: string }> = [];
    const fakeStore = {
      dispatch: (action: { type: string }) => {
        seenActions.push(action);
      },
      getState: () => ({
        ui: { activeTab: "trace" as const, theme: "light" as const },
        manifest: {
          name: "x",
          runtime: "mock" as const,
          permissions: "explicit" as const,
          tools: [],
        },
        manifestDraft: {
          name: "x",
          runtime: "mock" as const,
          permissions: "explicit" as const,
          tools: [],
        },
        runs: new Map(),
        activeRunId: null,
        replayMode: null,
        replayBuffer: [],
      }),
    };
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    const handler = (inst as unknown as { _onReplay: () => void })._onReplay;
    handler.call(inst);
    expect(seenActions.length).toBe(0);
  });

  test("playground-stop-replay event translates to store STOP_REPLAY", () => {
    const inst = instance();
    const seenActions: Array<{ type: string }> = [];
    const fakeStore: Pick<PlaygroundStore, "dispatch"> = {
      dispatch: (action) => {
        seenActions.push(action);
      },
    };
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    const handler = (inst as unknown as { _onStopReplay: () => void })._onStopReplay;
    handler.call(inst);
    expect(seenActions.length).toBe(1);
    expect(seenActions[0]?.type).toBe("STOP_REPLAY");
  });

  test("_canReplay() returns true when runs.size > 0 and replayMode is null and last run finished", () => {
    const inst = instance();
    Object.defineProperty(inst, "_state", {
      value: {
        ui: { activeTab: "trace", theme: "light" },
        runs: new Map([["r-1", { id: "r-1", status: "completed" }]]),
        replayMode: null,
        replayBuffer: [],
      },
      writable: true,
    });
    const result = (inst as unknown as { _canReplay: () => boolean })._canReplay.call(inst);
    expect(result).toBe(true);
  });

  test("_canReplay() returns false when replayMode is non-null (already replaying)", () => {
    const inst = instance();
    Object.defineProperty(inst, "_state", {
      value: {
        ui: { activeTab: "trace", theme: "light" },
        runs: new Map([["r-1", { id: "r-1", status: "completed" }]]),
        replayMode: { runId: "r-1", nextIndex: 0 },
        replayBuffer: [],
      },
      writable: true,
    });
    const result = (inst as unknown as { _canReplay: () => boolean })._canReplay.call(inst);
    expect(result).toBe(false);
  });

  test("_canReplay() returns false when the last run is still 'running'", () => {
    // Replaying a still-running run would race the live RECEIVE_EVENT
    // stream against the replay engine's cursor read of the same events
    // array. The shell's _canReplay() must hide the button while the
    // last run is in flight.
    const inst = instance();
    Object.defineProperty(inst, "_state", {
      value: {
        ui: { activeTab: "trace", theme: "light" },
        runs: new Map([
          ["r-1", { id: "r-1", status: "completed" }],
          ["r-2", { id: "r-2", status: "running" }],
        ]),
        replayMode: null,
        replayBuffer: [],
      },
      writable: true,
    });
    const result = (inst as unknown as { _canReplay: () => boolean })._canReplay.call(inst);
    expect(result).toBe(false);
  });

  test("_canReplay() returns true when the last run is 'cancelled' or 'errored' (terminal states allow replay)", () => {
    const inst = instance();
    for (const status of ["cancelled", "errored"]) {
      Object.defineProperty(inst, "_state", {
        value: {
          ui: { activeTab: "trace", theme: "light" },
          runs: new Map([["r-1", { id: "r-1", status }]]),
          replayMode: null,
          replayBuffer: [],
        },
        writable: true,
      });
      const result = (inst as unknown as { _canReplay: () => boolean })._canReplay.call(inst);
      expect(result).toBe(true);
    }
  });

  test("_isReplaying() reflects replayMode presence", () => {
    const inst = instance();
    Object.defineProperty(inst, "_state", {
      value: {
        ui: { activeTab: "trace", theme: "light" },
        runs: new Map(),
        replayMode: { runId: "r-1", nextIndex: 0 },
        replayBuffer: [],
      },
      writable: true,
    });
    expect((inst as unknown as { _isReplaying: () => boolean })._isReplaying.call(inst)).toBe(true);
    Object.defineProperty(inst, "_state", {
      value: {
        ui: { activeTab: "trace", theme: "light" },
        runs: new Map(),
        replayMode: null,
        replayBuffer: [],
      },
      writable: true,
    });
    expect((inst as unknown as { _isReplaying: () => boolean })._isReplaying.call(inst)).toBe(
      false,
    );
  });

  test("tab-button click translates to store SET_TAB", () => {
    const inst = instance();
    const seenActions: Array<{ type: string; tab?: string }> = [];
    const fakeStore: Pick<PlaygroundStore, "dispatch"> = {
      dispatch: (action) => {
        seenActions.push(action);
      },
    };
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    const handler = (inst as unknown as { _onTabSelect: (t: "trace" | "manifest") => void })
      ._onTabSelect;
    handler.call(inst, "manifest");
    expect(seenActions.length).toBe(1);
    expect(seenActions[0]?.type).toBe("SET_TAB");
    expect(seenActions[0]?.tab).toBe("manifest");
  });
});

describe("DocsPlaygroundShell — activate (mock runtime happy path)", () => {
  test("activate() reads manifest.runtime, picks the mock factory, and flips to active", async () => {
    const inst = instance();
    const runner = fakeRunner();
    const fakeStore = makeFakeStoreWithManifest({ runtime: "mock" });
    Object.defineProperty(inst, "mockRunnerFactory", {
      value: async () => runner,
      writable: true,
    });
    Object.defineProperty(inst, "_phase", { value: "ready-to-activate", writable: true });
    Object.defineProperty(inst, "_modelId", { value: null, writable: true });
    Object.defineProperty(inst, "_errorText", { value: "", writable: true });
    Object.defineProperty(inst, "_loadProgressText", { value: "", writable: true });
    Object.defineProperty(inst, "_state", { value: fakeStore.getState(), writable: true });
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    Object.defineProperty(inst, "_cachedRunner", { value: null, writable: true });
    Object.defineProperty(inst, "_unsubscribe", { value: null, writable: true });

    await inst.activate();

    expect(inst.__phase).toBe("active");
    expect(inst.__cachedRunner).toBe(runner);
    expect(inst.__errorText).toBe("");
    // The store is rebuilt on activate; just assert non-null.
    expect(inst.__store).not.toBeNull();
  });

  test("activate flips to 'error' phase when factory rejects", async () => {
    const inst = instance();
    const fakeStore = makeFakeStoreWithManifest({ runtime: "mock" });
    Object.defineProperty(inst, "mockRunnerFactory", {
      value: async () => {
        throw new Error("kaboom");
      },
      writable: true,
    });
    Object.defineProperty(inst, "_phase", { value: "ready-to-activate", writable: true });
    Object.defineProperty(inst, "_modelId", { value: null, writable: true });
    Object.defineProperty(inst, "_errorText", { value: "", writable: true });
    Object.defineProperty(inst, "_loadProgressText", { value: "", writable: true });
    Object.defineProperty(inst, "_state", { value: fakeStore.getState(), writable: true });
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    Object.defineProperty(inst, "_cachedRunner", { value: null, writable: true });
    Object.defineProperty(inst, "_unsubscribe", { value: null, writable: true });

    await inst.activate();
    expect(inst.__phase).toBe("error");
    expect(inst.__errorText).toContain("kaboom");
  });

  test("activate rejects when no mockRunnerFactory was injected and runtime is mock", async () => {
    const inst = instance();
    const fakeStore = makeFakeStoreWithManifest({ runtime: "mock" });
    Object.defineProperty(inst, "mockRunnerFactory", { value: null, writable: true });
    Object.defineProperty(inst, "_phase", { value: "ready-to-activate", writable: true });
    Object.defineProperty(inst, "_modelId", { value: null, writable: true });
    Object.defineProperty(inst, "_errorText", { value: "", writable: true });
    Object.defineProperty(inst, "_loadProgressText", { value: "", writable: true });
    Object.defineProperty(inst, "_state", { value: fakeStore.getState(), writable: true });
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    Object.defineProperty(inst, "_cachedRunner", { value: null, writable: true });
    Object.defineProperty(inst, "_unsubscribe", { value: null, writable: true });

    await inst.activate();
    expect(inst.__phase).toBe("error");
    expect(inst.__errorText).toContain("No mock runner factory");
  });

  test("activate() reads the APPLIED manifest.runtime, NOT the in-progress draft", async () => {
    // Discriminator: applied=local-wasm, draft=mock. If activate() reads
    // from manifestDraft (a bug), it would call the mock factory; if it
    // reads from manifest (correct), it calls the model factory and
    // surfaces "No model runner factory" (because we don't inject one).
    // The error text discriminates.
    const fakeStore = makeFakeStoreWithManifest({
      runtime: "local-wasm-worker",
      draftRuntime: "mock",
    });
    const inst = instance();
    let mockCalled = false;
    Object.defineProperty(inst, "mockRunnerFactory", {
      value: async () => {
        mockCalled = true;
        return fakeRunner();
      },
      writable: true,
    });
    Object.defineProperty(inst, "runnerFactory", { value: null, writable: true });
    Object.defineProperty(inst, "_phase", { value: "ready-to-activate", writable: true });
    Object.defineProperty(inst, "_modelId", { value: null, writable: true });
    Object.defineProperty(inst, "_errorText", { value: "", writable: true });
    Object.defineProperty(inst, "_loadProgressText", { value: "", writable: true });
    Object.defineProperty(inst, "_state", { value: fakeStore.getState(), writable: true });
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    Object.defineProperty(inst, "_cachedRunner", { value: null, writable: true });
    Object.defineProperty(inst, "_unsubscribe", { value: null, writable: true });

    await inst.activate();

    expect(mockCalled).toBe(false);
    expect(inst.__phase).toBe("error");
    // The error message confirms we hit the local-wasm branch (which
    // looked for a model runner factory that wasn't there), not the mock
    // branch.
    expect(inst.__errorText).toContain("No model runner factory");
  });

  test("activate() symmetric: applied=mock + draft=local-wasm calls the mock factory", async () => {
    const fakeStore = makeFakeStoreWithManifest({
      runtime: "mock",
      draftRuntime: "local-wasm-worker",
    });
    const inst = instance();
    const runner = fakeRunner();
    let mockCalled = false;
    Object.defineProperty(inst, "mockRunnerFactory", {
      value: async () => {
        mockCalled = true;
        return runner;
      },
      writable: true,
    });
    let modelCalled = false;
    Object.defineProperty(inst, "runnerFactory", {
      value: async () => {
        modelCalled = true;
        return runner;
      },
      writable: true,
    });
    Object.defineProperty(inst, "_phase", { value: "ready-to-activate", writable: true });
    Object.defineProperty(inst, "_modelId", {
      value: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
      writable: true,
    });
    Object.defineProperty(inst, "_errorText", { value: "", writable: true });
    Object.defineProperty(inst, "_loadProgressText", { value: "", writable: true });
    Object.defineProperty(inst, "_state", { value: fakeStore.getState(), writable: true });
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    Object.defineProperty(inst, "_cachedRunner", { value: null, writable: true });
    Object.defineProperty(inst, "_unsubscribe", { value: null, writable: true });

    await inst.activate();

    expect(mockCalled).toBe(true);
    expect(modelCalled).toBe(false);
    expect(inst.__phase).toBe("active");
  });

  test("activate rejects when runtime is agents-js-gateway (no adapter, defensive path)", async () => {
    const inst = instance();
    const fakeStore = makeFakeStoreWithManifest({ runtime: "agents-js-gateway" });
    Object.defineProperty(inst, "mockRunnerFactory", { value: null, writable: true });
    Object.defineProperty(inst, "runnerFactory", { value: null, writable: true });
    Object.defineProperty(inst, "_phase", { value: "ready-to-activate", writable: true });
    Object.defineProperty(inst, "_modelId", { value: null, writable: true });
    Object.defineProperty(inst, "_errorText", { value: "", writable: true });
    Object.defineProperty(inst, "_loadProgressText", { value: "", writable: true });
    Object.defineProperty(inst, "_state", { value: fakeStore.getState(), writable: true });
    Object.defineProperty(inst, "_store", { value: fakeStore, writable: true });
    Object.defineProperty(inst, "_cachedRunner", { value: null, writable: true });
    Object.defineProperty(inst, "_unsubscribe", { value: null, writable: true });

    await inst.activate();
    expect(inst.__phase).toBe("error");
    expect(inst.__errorText).toContain("not yet implemented");
  });
});

// ------------------------- helpers -------------------------

function getInternal<T>(inst: DocsPlaygroundShell, key: string): T {
  return (inst as unknown as Record<string, T>)[key];
}

interface MaybeTemplateResult {
  strings?: readonly string[];
  values?: readonly unknown[];
}

function renderShell(inst: DocsPlaygroundShell): MaybeTemplateResult {
  return (
    DocsPlaygroundShell.prototype as unknown as { render: () => MaybeTemplateResult }
  ).render.call(inst);
}

/**
 * Stage the minimum reactive-state surface a render call needs. Tests that
 * exercise render branching set the phase + a default state struct so the
 * sub-template helpers don't trip on `this._state?.ui`.
 */
function stagePhase(inst: DocsPlaygroundShell, phase: string): void {
  Object.defineProperty(inst, "_phase", { value: phase, writable: true });
  Object.defineProperty(inst, "_modelId", { value: null, writable: true });
  Object.defineProperty(inst, "_loadProgressText", { value: "", writable: true });
  Object.defineProperty(inst, "_errorText", { value: "", writable: true });
  Object.defineProperty(inst, "_state", { value: null, writable: true });
}

/**
 * Build a minimal `PlaygroundStore`-shaped fake whose `getState()` returns
 * a manifest with the given runtime. `dispatch` is a no-op; activate()'s
 * post-rebuild `dispatch` is exercised via real-store integration tests
 * elsewhere — here we just verify the runtime-selection path.
 *
 * `draftRuntime` defaults to `runtime` when omitted; pass a distinct value
 * to discriminate "shell reads from manifest" vs "shell reads from
 * manifestDraft" at the activate() seam.
 */
function makeFakeStoreWithManifest(opts: {
  runtime: ManifestDraft["runtime"];
  draftRuntime?: ManifestDraft["runtime"];
}): Pick<PlaygroundStore, "dispatch" | "getState"> {
  const manifest: ManifestDraft = {
    name: "x",
    runtime: opts.runtime,
    permissions: "explicit",
    tools: [],
  };
  const manifestDraft: ManifestDraft = {
    ...manifest,
    runtime: opts.draftRuntime ?? opts.runtime,
  };
  return {
    dispatch: () => {},
    getState: () => ({
      ui: { activeTab: "trace", theme: "light" },
      manifest,
      manifestDraft,
      runs: new Map(),
      activeRunId: null,
      replayMode: null,
    }),
  };
}

/**
 * Recursively walk a `lit-html` `TemplateResult`, concatenating every
 * static `strings` chunk it contains. Nested templates appear in `.values`
 * (not `.strings`), so a non-recursive `result.strings.join("")` misses
 * everything inside conditional sub-templates like `_renderActiveBody()`.
 */
function collectAllStrings(node: MaybeTemplateResult | unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const t = node as MaybeTemplateResult;
  let out = "";
  if (Array.isArray(t.strings)) out += t.strings.join("");
  if (Array.isArray(t.values)) {
    for (const v of t.values) out += collectAllStrings(v);
  }
  return out;
}
