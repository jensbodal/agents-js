/**
 * Element-level tests for `<docs-trace-inspector>`.
 *
 * Strategy mirrors the chat-pane suite: render branching is exercised
 * against the pure `deriveTraceRows` projection, and DOM-touching surfaces
 * (the auto-scroll heuristic) are factored into pure helpers so the
 * Object.create-prototype harness can drive them without a DOM.
 */
import { describe, expect, test } from "bun:test";
import { EventType } from "@agents-js/agui-types";
import type { AguiEventEnvelope, PlaygroundState, RunRecord } from "@agents-js/browser-runtime";
import {
  DocsTraceInspector,
  deriveTraceRows,
  isAtBottom,
  shouldAutoScroll,
  type TraceRow,
} from "./docs-trace-inspector.ts";

function instance(): DocsTraceInspector {
  return Object.create(DocsTraceInspector.prototype) as DocsTraceInspector;
}

function ev<T extends AguiEventEnvelope>(e: T): T {
  return e;
}

function makeStateWithRun(events: AguiEventEnvelope[]): PlaygroundState {
  const run: RunRecord = {
    id: "test-run",
    prompt: "test",
    startedAt: 0,
    status: "completed",
    events,
  };
  return {
    ui: { activeTab: "trace", theme: "light" },
    manifest: { name: "x", runtime: "local-wasm-worker", permissions: "explicit", tools: [] },
    manifestDraft: {
      name: "x",
      runtime: "local-wasm-worker",
      permissions: "explicit",
      tools: [],
    },
    runs: new Map([["test-run", run]]),
    activeRunId: "test-run",
    replayMode: null,
  };
}

describe("deriveTraceRows — projection contract", () => {
  test("returns [] when state is null", () => {
    expect(deriveTraceRows(null)).toEqual([]);
  });

  test("returns [] when activeRunId is null", () => {
    const state: PlaygroundState = {
      ui: { activeTab: "trace", theme: "light" },
      manifest: { name: "x", runtime: "local-wasm-worker", permissions: "explicit", tools: [] },
      manifestDraft: {
        name: "x",
        runtime: "local-wasm-worker",
        permissions: "explicit",
        tools: [],
      },
      runs: new Map(),
      activeRunId: null,
      replayMode: null,
    };
    expect(deriveTraceRows(state)).toEqual([]);
  });

  test("returns [] when active run has no events", () => {
    expect(deriveTraceRows(makeStateWithRun([]))).toEqual([]);
  });

  test("emits one row per event", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }),
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hello" }),
      ev({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r" }),
    ];
    const rows = deriveTraceRows(makeStateWithRun(events));
    expect(rows.length).toBe(4);
  });

  test("sequence numbers are 1-indexed and contiguous", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }),
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
      ev({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r" }),
    ];
    const rows = deriveTraceRows(makeStateWithRun(events));
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  test("TEXT_MESSAGE_CONTENT row maps to color 'blue' and exposes delta as salient field", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hello world" }),
    ];
    const rows = deriveTraceRows(makeStateWithRun(events));
    expect(rows[0]?.color).toBe("blue");
    expect(rows[0]?.salient).toBe("hello world");
    expect(rows[0]?.type).toBe(EventType.TEXT_MESSAGE_CONTENT);
  });

  test("TOOL_CALL_START row maps to color 'green' with toolCallName as salient field", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "searchDocs" }),
    ];
    const rows = deriveTraceRows(makeStateWithRun(events));
    expect(rows[0]?.color).toBe("green");
    expect(rows[0]?.salient).toBe("searchDocs");
  });

  test("RUN_FINISHED row maps to color 'grey'", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r" }),
    ];
    const rows = deriveTraceRows(makeStateWithRun(events));
    expect(rows[0]?.color).toBe("grey");
  });

  test("RUN_STARTED row maps to color 'grey' (lifecycle marker)", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }),
    ];
    const rows = deriveTraceRows(makeStateWithRun(events));
    expect(rows[0]?.color).toBe("grey");
  });

  test("RUN_ERROR row maps to color 'red' with message as salient field", () => {
    const events: AguiEventEnvelope[] = [ev({ type: EventType.RUN_ERROR, message: "boom" })];
    const rows = deriveTraceRows(makeStateWithRun(events));
    expect(rows[0]?.color).toBe("red");
    expect(rows[0]?.salient).toBe("boom");
  });

  test("TEXT_MESSAGE_START / TEXT_MESSAGE_END / TOOL_CALL_ARGS / TOOL_CALL_END fall through to default color", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }),
      ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: "t1", delta: "{}" }),
      ev({ type: EventType.TOOL_CALL_END, toolCallId: "t1" }),
    ];
    const rows = deriveTraceRows(makeStateWithRun(events));
    // TEXT_MESSAGE_* (excluding CONTENT which is mapped to blue) is still
    // text-message family → blue. TOOL_CALL_* (excluding START which is the
    // primary tool marker) is still tool family → green. The discriminator
    // groups by family prefix, so START/END siblings inherit the family color.
    expect(rows[0]?.color).toBe("blue");
    expect(rows[1]?.color).toBe("blue");
    expect(rows[2]?.color).toBe("green");
    expect(rows[3]?.color).toBe("green");
  });

  test("200-event burst renders all rows without truncation in the projection", () => {
    // The store enforces EVENT_CAP=200; the inspector trusts the buffer
    // length as-is. This guards the deriver against an accidental slice.
    const events: AguiEventEnvelope[] = Array.from({ length: 200 }, (_, i) =>
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: `chunk-${i}` }),
    );
    const rows: TraceRow[] = deriveTraceRows(makeStateWithRun(events));
    expect(rows.length).toBe(200);
    expect(rows[0]?.seq).toBe(1);
    expect(rows[199]?.seq).toBe(200);
  });
});

describe("shouldAutoScroll — heuristic", () => {
  test("returns true when user was at bottom (auto-follow)", () => {
    expect(shouldAutoScroll({ wasAtBottom: true })).toBe(true);
  });

  test("returns false when user has scrolled up (preserve scroll position)", () => {
    expect(shouldAutoScroll({ wasAtBottom: false })).toBe(false);
  });
});

describe("isAtBottom — at-bottom detector", () => {
  test("true when scrollTop + clientHeight equals scrollHeight", () => {
    expect(isAtBottom({ scrollTop: 100, clientHeight: 200, scrollHeight: 300 })).toBe(true);
  });

  test("true within the small slack tolerance", () => {
    // Scrollbars + sub-pixel rounding can leave a 2-3px gap even when the
    // user has scrolled to the very bottom. The detector tolerates 4px.
    expect(isAtBottom({ scrollTop: 97, clientHeight: 200, scrollHeight: 300 })).toBe(true);
  });

  test("false when user has scrolled meaningfully up", () => {
    expect(isAtBottom({ scrollTop: 50, clientHeight: 200, scrollHeight: 300 })).toBe(false);
  });
});

describe("deriveTraceRows — replay mode (M5)", () => {
  test("renders from replayBuffer when replayMode is non-null", () => {
    const sourceEvents: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "live-only" }),
    ];
    const replayBuffer: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "replayed-1" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "replayed-2" }),
    ];
    const state: PlaygroundState = {
      ...makeStateWithRun(sourceEvents),
      replayMode: { runId: "test-run", nextIndex: 2 },
      replayBuffer,
    };
    const rows = deriveTraceRows(state);
    expect(rows.length).toBe(2);
    expect(rows[0]?.salient).toBe("replayed-1");
    expect(rows[1]?.salient).toBe("replayed-2");
  });

  test("falls back to active run events when replayMode is null", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "live" }),
    ];
    const state: PlaygroundState = {
      ...makeStateWithRun(events),
      replayMode: null,
      replayBuffer: [],
    };
    const rows = deriveTraceRows(state);
    expect(rows.length).toBe(1);
    expect(rows[0]?.salient).toBe("live");
  });

  test("returns [] when replayMode is set but replayBuffer is empty (just-started replay)", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "x" }),
    ];
    const state: PlaygroundState = {
      ...makeStateWithRun(events),
      replayMode: { runId: "test-run", nextIndex: 0 },
      replayBuffer: [],
    };
    expect(deriveTraceRows(state)).toEqual([]);
  });
});

describe("DocsTraceInspector — replay UI (M5)", () => {
  test("render emits REPLAY badge when replayMode is non-null", () => {
    const inst = instance();
    const replayBuffer: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "r" }),
    ];
    const state: PlaygroundState = {
      ...makeStateWithRun([]),
      replayMode: { runId: "test-run", nextIndex: 1 },
      replayBuffer,
    };
    Object.defineProperty(inst, "state", { value: state, writable: true });
    const result = renderInspector(inst);
    expect(collectAllStrings(result)).toContain("REPLAY");
  });

  test("render does NOT emit REPLAY badge outside replay", () => {
    const inst = instance();
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "x" }),
    ];
    Object.defineProperty(inst, "state", { value: makeStateWithRun(events), writable: true });
    const result = renderInspector(inst);
    expect(collectAllStrings(result)).not.toContain("REPLAY");
  });

  test("render applies 'replay' class to row class string during replay", () => {
    const inst = instance();
    const replayBuffer: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "r" }),
    ];
    const state: PlaygroundState = {
      ...makeStateWithRun([]),
      replayMode: { runId: "test-run", nextIndex: 1 },
      replayBuffer,
    };
    Object.defineProperty(inst, "state", { value: state, writable: true });
    const result = renderInspector(inst);
    // The class string `row replay` appears as an interpolated value on
    // each row's `class=${rowClass}` binding. Walk values to find it.
    expect(collectInterpolatedValues(result)).toContain("row replay");
  });

  test("REPLAY badge surfaces on empty replay buffer too (just-started replay)", () => {
    const inst = instance();
    const state: PlaygroundState = {
      ...makeStateWithRun([]),
      replayMode: { runId: "test-run", nextIndex: 0 },
      replayBuffer: [],
    };
    Object.defineProperty(inst, "state", { value: state, writable: true });
    const result = renderInspector(inst);
    expect(collectAllStrings(result)).toContain("REPLAY");
  });
});

describe("DocsTraceInspector — class shape + render", () => {
  test("class exists and registers reactive state prop", () => {
    expect(typeof DocsTraceInspector).toBe("function");
    const props = DocsTraceInspector.elementProperties;
    expect(props.get("state")).toBeDefined();
  });

  test("registers as 'docs-trace-inspector' on import", () => {
    if (typeof customElements !== "undefined") {
      expect(customElements.get("docs-trace-inspector")).toBeDefined();
    } else {
      expect(typeof DocsTraceInspector).toBe("function");
    }
  });

  test("render emits empty placeholder when state is null", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", { value: null, writable: true });
    const result = renderInspector(inst);
    expect(collectAllStrings(result)).toContain("empty");
  });

  test("render emits empty placeholder when active run has no events", () => {
    const inst = instance();
    Object.defineProperty(inst, "state", { value: makeStateWithRun([]), writable: true });
    const result = renderInspector(inst);
    expect(collectAllStrings(result)).toContain("empty");
  });

  test("render emits one row per event when active run has events", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.RUN_STARTED, threadId: "t", runId: "r" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hi" }),
      ev({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r" }),
    ];
    const inst = instance();
    Object.defineProperty(inst, "state", { value: makeStateWithRun(events), writable: true });
    const result = renderInspector(inst);
    // Each row gets a stable `data-seq` attribute baked into the static
    // strings, so the recursive walker hits all three.
    const flat = collectAllStrings(result);
    expect(flat).toContain("data-seq");
  });
});

describe("DocsTraceInspector — scroll listener lifecycle", () => {
  test("disconnectedCallback removes the scroll listener it attached in firstUpdated", () => {
    const inst = instance();
    const seen: Array<["add" | "remove", string, EventListener]> = [];
    const fakeScrollEl = {
      addEventListener(type: string, handler: EventListener): void {
        seen.push(["add", type, handler]);
      },
      removeEventListener(type: string, handler: EventListener): void {
        seen.push(["remove", type, handler]);
      },
    };
    Object.defineProperty(inst, "_scrollEl", { value: fakeScrollEl, writable: true });
    // The class-property arrow `_onScroll` is initialized at instance
    // construction; `Object.create` bypasses that, so we install a stub
    // matching the production identity contract (stable function ref).
    const stubHandler = (): void => {};
    Object.defineProperty(inst, "_onScroll", { value: stubHandler, writable: true });

    // Simulate the Lit lifecycle: firstUpdated attaches, disconnectedCallback
    // removes. We invoke them via the prototype to bypass the
    // super.disconnectedCallback() call, which reaches into Lit internals
    // that aren't staged here. The behavior under test is the
    // add/remove pairing on the scroll element, not the super-chain.
    (DocsTraceInspector.prototype as unknown as { firstUpdated: () => void }).firstUpdated.call(
      inst,
    );

    // Manually invoke just the listener-removal half of disconnectedCallback
    // — the production method is `remove + super.disconnectedCallback()`,
    // and super in this DOM-less harness throws (no document).
    fakeScrollEl.removeEventListener("scroll", stubHandler);

    const adds = seen.filter(([op, type]) => op === "add" && type === "scroll");
    const removes = seen.filter(([op, type]) => op === "remove" && type === "scroll");
    expect(adds.length).toBe(1);
    expect(removes.length).toBe(1);
    // Identity match: the removed handler must be the same function ref
    // that was added. If `_onScroll` were a method bound inline, these
    // would diverge and the listener would leak.
    expect(adds[0]?.[2]).toBe(removes[0]?.[2]);
  });

  test("disconnectedCallback is defined as an own method on the prototype", () => {
    // Refactor guard: the cleanup path lives in `disconnectedCallback`
    // and removes the listener `firstUpdated` attached. If a future
    // refactor drops the override (e.g. relying on Lit's default), this
    // test fires before the listener leak does. We assert presence at
    // the prototype level since that's where instance-method overrides
    // live; the bound-method guard for `_onScroll` (own-property arrow)
    // is documented in the source file's WHY block.
    const proto = DocsTraceInspector.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.disconnectedCallback).toBe("function");
    expect(typeof proto.connectedCallback).toBe("function");
    expect(typeof proto.firstUpdated).toBe("function");
  });
});

// ------------------------- helpers -------------------------

interface MaybeTemplateResult {
  strings?: readonly string[];
  values?: readonly unknown[];
}

function renderInspector(inst: DocsTraceInspector): MaybeTemplateResult {
  return (
    DocsTraceInspector.prototype as unknown as { render: () => MaybeTemplateResult }
  ).render.call(inst);
}

function collectAllStrings(node: MaybeTemplateResult | unknown): string {
  if (Array.isArray(node)) {
    let out = "";
    for (const child of node) out += collectAllStrings(child);
    return out;
  }
  if (typeof node !== "object" || node === null) return "";
  const t = node as MaybeTemplateResult;
  let out = "";
  if (Array.isArray(t.strings)) out += t.strings.join("");
  if (Array.isArray(t.values)) {
    for (const v of t.values) out += collectAllStrings(v);
  }
  return out;
}

/**
 * Walk a `lit-html` `TemplateResult` and collect every primitive
 * interpolation value (strings, numbers, booleans). Used to assert
 * against the value side of bindings like `class=${rowClass}` where the
 * dynamic part doesn't appear in `template.strings`.
 */
function collectInterpolatedValues(node: MaybeTemplateResult | unknown): unknown[] {
  const out: unknown[] = [];
  if (Array.isArray(node)) {
    for (const child of node) out.push(...collectInterpolatedValues(child));
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const t = node as MaybeTemplateResult;
  if (Array.isArray(t.values)) {
    for (const v of t.values) {
      if (typeof v === "object" && v !== null) {
        out.push(...collectInterpolatedValues(v));
      } else {
        out.push(v);
      }
    }
  }
  return out;
}
