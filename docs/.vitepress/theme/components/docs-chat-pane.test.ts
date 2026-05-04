/**
 * Element-level tests for `<docs-chat-pane>`.
 *
 * Strategy: same Object.create-prototype harness as the run-controls suite
 * (Bun test runner is DOM-less). Render branching is exercised against
 * `deriveChatLines` directly so we can drive every transcript shape with
 * a fixture object without mounting Lit's reactive plumbing.
 */
import { describe, expect, test } from "bun:test";
import { EventType } from "@agents-js/agui-types";
import type { AguiEventEnvelope, PlaygroundState, RunRecord } from "@agents-js/browser-runtime";
import { DocsChatPane, deriveChatLines, getActiveRun, pickRenderRun } from "./docs-chat-pane.ts";

function instance(): DocsChatPane {
  return Object.create(DocsChatPane.prototype) as DocsChatPane;
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-test",
    prompt: "what is acp",
    startedAt: 1000,
    status: "running",
    events: [],
    ...overrides,
  };
}

function ev<T extends AguiEventEnvelope>(e: T): T {
  return e;
}

describe("deriveChatLines — projection contract", () => {
  test("returns [] when run is undefined", () => {
    expect(deriveChatLines(undefined)).toEqual([]);
  });

  test("emits a single user line when run has prompt + no events", () => {
    const lines = deriveChatLines(makeRun({ prompt: "hello" }));
    expect(lines).toEqual([{ role: "user", text: "hello" }]);
  });

  test("folds TEXT_MESSAGE_START + multiple CONTENT into one agent line", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hello " }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "world" }),
      ev({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }),
    ];
    const lines = deriveChatLines(makeRun({ prompt: "hi", events }));
    expect(lines).toEqual([
      { role: "user", text: "hi" },
      { role: "agent", text: "hello world" },
    ]);
  });

  test("emits a tool line per TOOL_CALL_START with the tool name", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "searchDocs" }),
    ];
    const lines = deriveChatLines(makeRun({ events }));
    expect(lines[1]).toEqual({ role: "tool", text: "→ searchDocs" });
  });

  test("emits an error line for RUN_ERROR with message", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.RUN_ERROR, message: "model exploded" }),
    ];
    const lines = deriveChatLines(makeRun({ events }));
    expect(lines[1]).toEqual({ role: "error", text: "model exploded" });
  });

  test("RUN_ERROR with code === 'cancelled' renders as cancelled, not error", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.RUN_ERROR, message: "run cancelled", code: "cancelled" }),
    ];
    const lines = deriveChatLines(makeRun({ events }));
    expect(lines[1]).toEqual({ role: "cancelled", text: "run cancelled" });
  });

  test("ignores TOOL_CALL_ARGS, TOOL_CALL_END, and RUN_FINISHED at chat surface", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "x" }),
      ev({ type: EventType.TOOL_CALL_ARGS, toolCallId: "t1", delta: "{}" }),
      ev({ type: EventType.TOOL_CALL_END, toolCallId: "t1" }),
      ev({ type: EventType.RUN_FINISHED, threadId: "th", runId: "r" }),
    ];
    const lines = deriveChatLines(makeRun({ events }));
    // user + tool only.
    expect(lines.length).toBe(2);
    expect(lines.map((l) => l.role)).toEqual(["user", "tool"]);
  });

  test("interleaved tool + text events render in source order", () => {
    const events: AguiEventEnvelope[] = [
      ev({ type: EventType.TOOL_CALL_START, toolCallId: "t1", toolCallName: "searchDocs" }),
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "result" }),
      ev({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }),
    ];
    const lines = deriveChatLines(makeRun({ events }));
    expect(lines.map((l) => l.role)).toEqual(["user", "tool", "agent"]);
  });
});

describe("getActiveRun — projection helper", () => {
  test("returns undefined when state is null", () => {
    expect(getActiveRun(null)).toBeUndefined();
  });

  test("returns undefined when activeRunId is null", () => {
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
    expect(getActiveRun(state)).toBeUndefined();
  });

  test("returns the active RunRecord by id", () => {
    const run = makeRun({ id: "r-1" });
    const state: PlaygroundState = {
      ui: { activeTab: "trace", theme: "light" },
      manifest: { name: "x", runtime: "local-wasm-worker", permissions: "explicit", tools: [] },
      manifestDraft: {
        name: "x",
        runtime: "local-wasm-worker",
        permissions: "explicit",
        tools: [],
      },
      runs: new Map([["r-1", run]]),
      activeRunId: "r-1",
      replayMode: null,
    };
    expect(getActiveRun(state)).toBe(run);
  });
});

describe("DocsChatPane — class shape + dispatch", () => {
  test("class exists and has expected reactive props", () => {
    expect(typeof DocsChatPane).toBe("function");
    const props = DocsChatPane.elementProperties;
    expect(props.get("state")).toBeDefined();
    expect(props.get("inputDisabled")).toBeDefined();
    expect(props.get("inputValue")).toBeDefined();
  });

  test("inputDisabled is Boolean-typed", () => {
    expect(DocsChatPane.elementProperties.get("inputDisabled")?.type).toBe(Boolean);
  });

  test("_send dispatches playground-prompt with trimmed text", () => {
    const inst = instance();
    Object.defineProperty(inst, "inputValue", { value: "  hello  ", writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    (inst as unknown as { _send: () => void })._send.call(inst);
    expect(seen.length).toBe(1);
    expect(seen[0]?.type).toBe("playground-prompt");
    expect((seen[0]?.detail as { prompt: string }).prompt).toBe("hello");
  });

  test("_send is a no-op when inputValue is empty / whitespace-only", () => {
    const inst = instance();
    Object.defineProperty(inst, "inputValue", { value: "   ", writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    (inst as unknown as { _send: () => void })._send.call(inst);
    expect(seen.length).toBe(0);
  });

  test("_cancel dispatches playground-cancel", () => {
    const inst = instance();
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    (inst as unknown as { _cancel: () => void })._cancel.call(inst);
    expect(seen[0]?.type).toBe("playground-cancel");
    expect(seen[0]?.bubbles).toBe(true);
    expect(seen[0]?.composed).toBe(true);
  });

  test("Enter keydown triggers _send", () => {
    const inst = instance();
    Object.defineProperty(inst, "inputValue", { value: "hi", writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (
      inst as unknown as {
        _onKeydown: (e: KeyboardEvent) => void;
      }
    )._onKeydown;
    // Bun's test runtime has no DOM, so we duck-type the KeyboardEvent shape
    // the handler reads (only `e.key`).
    handler.call(inst, { key: "Enter" } as unknown as KeyboardEvent);
    expect(seen.length).toBe(1);
    expect(seen[0]?.type).toBe("playground-prompt");
  });

  test("non-Enter keydown does NOT trigger _send", () => {
    const inst = instance();
    Object.defineProperty(inst, "inputValue", { value: "hi", writable: true });
    const seen: CustomEvent[] = [];
    inst.dispatchEvent = (e: Event): boolean => {
      seen.push(e as CustomEvent);
      return true;
    };
    const handler = (
      inst as unknown as {
        _onKeydown: (e: KeyboardEvent) => void;
      }
    )._onKeydown;
    handler.call(inst, { key: "a" } as unknown as KeyboardEvent);
    expect(seen.length).toBe(0);
  });
});

describe("pickRenderRun — replay synthesis", () => {
  test("returns active run when replayMode is null", () => {
    const run = makeRun({ id: "live-id", events: [] });
    const state: PlaygroundState = {
      ui: { activeTab: "trace", theme: "light" },
      manifest: { name: "x", runtime: "local-wasm-worker", permissions: "explicit", tools: [] },
      manifestDraft: {
        name: "x",
        runtime: "local-wasm-worker",
        permissions: "explicit",
        tools: [],
      },
      runs: new Map([["live-id", run]]),
      activeRunId: "live-id",
      replayMode: null,
      replayBuffer: [],
    };
    expect(pickRenderRun(state)).toBe(run);
  });

  test("returns synthetic run with replayBuffer events when replayMode is non-null", () => {
    const sourceEvents: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "old" }),
    ];
    const replayBuffer: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "replayed" }),
    ];
    const sourceRun = makeRun({ id: "src", prompt: "test", events: sourceEvents });
    const state: PlaygroundState = {
      ui: { activeTab: "trace", theme: "light" },
      manifest: { name: "x", runtime: "local-wasm-worker", permissions: "explicit", tools: [] },
      manifestDraft: {
        name: "x",
        runtime: "local-wasm-worker",
        permissions: "explicit",
        tools: [],
      },
      runs: new Map([["src", sourceRun]]),
      activeRunId: null,
      replayMode: { runId: "src", nextIndex: 2 },
      replayBuffer,
    };
    const synth = pickRenderRun(state);
    expect(synth?.id).toBe("src");
    expect(synth?.prompt).toBe("test");
    // Source events must NOT be reused; the synthetic run carries the buffer.
    expect(synth?.events).toBe(replayBuffer);
    expect(synth?.events.length).toBe(2);
  });

  test("returns undefined when replayMode points at a missing run", () => {
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
      replayMode: { runId: "ghost", nextIndex: 0 },
      replayBuffer: [],
    };
    expect(pickRenderRun(state)).toBeUndefined();
  });

  test("returns undefined when state is null", () => {
    expect(pickRenderRun(null)).toBeUndefined();
  });

  test("deriveChatLines on synthetic replay run produces lines from replayBuffer", () => {
    const replayBuffer: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "replay-text" }),
    ];
    const sourceRun = makeRun({
      id: "src",
      prompt: "what",
      events: [ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "live" })],
    });
    const state: PlaygroundState = {
      ui: { activeTab: "trace", theme: "light" },
      manifest: { name: "x", runtime: "local-wasm-worker", permissions: "explicit", tools: [] },
      manifestDraft: {
        name: "x",
        runtime: "local-wasm-worker",
        permissions: "explicit",
        tools: [],
      },
      runs: new Map([["src", sourceRun]]),
      activeRunId: null,
      replayMode: { runId: "src", nextIndex: 2 },
      replayBuffer,
    };
    const lines = deriveChatLines(pickRenderRun(state));
    // user line + agent line — and the agent text reflects the replay buffer,
    // not the source run's "live" delta.
    expect(lines.map((l) => l.role)).toEqual(["user", "agent"]);
    expect(lines[1]?.text).toBe("replay-text");
  });
});

describe("DocsChatPane — replay UI", () => {
  test("render applies 'replay' suffix to line class strings when replayMode is set", () => {
    const inst = instance();
    const replayBuffer: AguiEventEnvelope[] = [
      ev({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }),
      ev({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "x" }),
    ];
    const sourceRun = makeRun({ id: "src", prompt: "p", events: [] });
    const state: PlaygroundState = {
      ui: { activeTab: "trace", theme: "light" },
      manifest: { name: "x", runtime: "local-wasm-worker", permissions: "explicit", tools: [] },
      manifestDraft: {
        name: "x",
        runtime: "local-wasm-worker",
        permissions: "explicit",
        tools: [],
      },
      runs: new Map([["src", sourceRun]]),
      activeRunId: null,
      replayMode: { runId: "src", nextIndex: 2 },
      replayBuffer,
    };
    Object.defineProperty(inst, "state", { value: state, writable: true });
    Object.defineProperty(inst, "inputValue", { value: "", writable: true });
    Object.defineProperty(inst, "inputDisabled", { value: true, writable: true });
    const result = renderChatPane(inst);
    // The interpolation `lineClassFor(l.role)` produces strings like
    // "line user replay" / "line agent replay" during replay.
    const interpolated = collectInterpolatedValues(result);
    expect(interpolated.some((v) => typeof v === "string" && v.includes("replay"))).toBe(true);
  });

  test("Cancel button NOT shown during replay (replays don't have a 'running' run to cancel)", () => {
    const inst = instance();
    const replayBuffer: AguiEventEnvelope[] = [];
    const sourceRun = makeRun({
      id: "src",
      prompt: "p",
      status: "running", // even with a 'running' active run staged, replay suppresses cancel
    });
    const state: PlaygroundState = {
      ui: { activeTab: "trace", theme: "light" },
      manifest: { name: "x", runtime: "local-wasm-worker", permissions: "explicit", tools: [] },
      manifestDraft: {
        name: "x",
        runtime: "local-wasm-worker",
        permissions: "explicit",
        tools: [],
      },
      runs: new Map([["src", sourceRun]]),
      activeRunId: "src",
      replayMode: { runId: "src", nextIndex: 0 },
      replayBuffer,
    };
    Object.defineProperty(inst, "state", { value: state, writable: true });
    Object.defineProperty(inst, "inputValue", { value: "", writable: true });
    Object.defineProperty(inst, "inputDisabled", { value: false, writable: true });
    const result = renderChatPane(inst);
    expect(collectAllStrings(result)).not.toContain("Cancel");
  });
});

describe("DocsChatPane — registration", () => {
  test("registers as 'docs-chat-pane' on import", () => {
    if (typeof customElements !== "undefined") {
      const Ctor = customElements.get("docs-chat-pane");
      expect(Ctor).toBeDefined();
    } else {
      expect(typeof DocsChatPane).toBe("function");
    }
  });
});

// ------------------------- helpers -------------------------

interface MaybeTemplateResult {
  strings?: readonly string[];
  values?: readonly unknown[];
}

function renderChatPane(inst: DocsChatPane): MaybeTemplateResult {
  return (DocsChatPane.prototype as unknown as { render: () => MaybeTemplateResult }).render.call(
    inst,
  );
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
