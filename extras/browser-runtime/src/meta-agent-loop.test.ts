import { describe, expect, it } from "bun:test";
import type { PriorEntry } from "./action-schema.ts";
import type { JsonRpcMessage } from "./browser-acp-shim.ts";
import { createMetaAgentLoop, type ModelAdapter, truncateToolResult } from "./meta-agent-loop.ts";
import { createInMemoryTelemetry } from "./telemetry.ts";
import type { LocalToolRegistry } from "./tool-registry.ts";

function emitter() {
  const events: JsonRpcMessage[] = [];
  return { emit: (m: JsonRpcMessage) => events.push(m), events };
}

describe("createMetaAgentLoop", () => {
  it("emits answer.chunk events when decide returns kind=answer", async () => {
    const adapter: ModelAdapter = {
      decideAction: async () => ({ raw: '{"kind":"answer","answerDraft":"hello world"}' }),
      streamAnswer: async function* () {
        yield "hello ";
        yield "world";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({}),
      names: () => ["searchDocs", "readCodeSnippet"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit, events } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "hi" }, emit);

    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    const chunks = events.filter((e: any) => e.params?.kind === "answer.chunk");
    expect(chunks.length).toBe(2);
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    const done = events.find((e: any) => e.params?.kind === "answer.done");
    expect(done).toBeDefined();
  });

  it("invokes the named tool when decide returns kind=tool, then continues to answer", async () => {
    let toolCalled = false;
    const decisions = [
      '{"kind":"tool","tool":"searchDocs","args":{"query":"acp"}}',
      '{"kind":"answer","answerDraft":"acp is a protocol"}',
    ];
    let n = 0;
    const seenPriors: PriorEntry[][] = [];
    const adapter: ModelAdapter = {
      decideAction: async ({ prior }) => {
        // Snapshot at the moment of the call; the loop mutates the same
        // array reference between iterations.
        seenPriors.push([...prior]);
        return { raw: decisions[n++] ?? "" };
      },
      streamAnswer: async function* () {
        yield "acp is a protocol";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async (name) => {
        toolCalled = true;
        expect(name).toBe("searchDocs");
        return { hits: [{ heading: "ACP" }] };
      },
      names: () => ["searchDocs", "readCodeSnippet"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit, events } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "what is acp" }, emit);

    expect(toolCalled).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    expect(events.some((e: any) => e.params?.kind === "tool.invoked")).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    expect(events.some((e: any) => e.params?.kind === "answer.done")).toBe(true);

    // The second decideAction must see the tool-call entry AND the
    // tool-result entry. Without the result entry, the model has no way
    // to ground its answer on what searchDocs actually returned.
    expect(seenPriors.length).toBe(2);
    expect(seenPriors[0]).toEqual([]);
    const second = seenPriors[1] ?? [];
    expect(second.length).toBe(2);
    expect(second[0]?.kind).toBe("tool");
    expect(second[1]?.kind).toBe("tool-result");
    const resultEntry = second[1] as Extract<PriorEntry, { kind: "tool-result" }>;
    expect(resultEntry.tool).toBe("searchDocs");
    expect(resultEntry.result).toEqual({ hits: [{ heading: "ACP" }] });
    expect(resultEntry.truncated).toBe(false);
  });

  it("captures tool result into prior so subsequent decideAction sees it", async () => {
    const decisions = [
      '{"kind":"tool","tool":"searchDocs","args":{"query":"acp"}}',
      '{"kind":"answer","answerDraft":"done"}',
    ];
    let n = 0;
    const seenPriors: PriorEntry[][] = [];
    const adapter: ModelAdapter = {
      decideAction: async ({ prior }) => {
        seenPriors.push([...prior]);
        return { raw: decisions[n++] ?? "" };
      },
      streamAnswer: async function* () {
        yield "done";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({ hits: [{ heading: "Agent Client Protocol" }] }),
      names: () => ["searchDocs"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "what is acp" }, emit);

    const second = seenPriors[1] ?? [];
    const resultEntry = second.find((e) => e.kind === "tool-result") as
      | Extract<PriorEntry, { kind: "tool-result" }>
      | undefined;
    expect(resultEntry).toBeDefined();
    expect(resultEntry?.result).toEqual({ hits: [{ heading: "Agent Client Protocol" }] });
  });

  it("tool failure pushes a tool-result with error and continues to next iteration", async () => {
    const decisions = [
      '{"kind":"tool","tool":"searchDocs","args":{"query":"acp"}}',
      '{"kind":"answer","answerDraft":"unable to find docs, here\'s what I know"}',
    ];
    let n = 0;
    const seenPriors: PriorEntry[][] = [];
    const adapter: ModelAdapter = {
      decideAction: async ({ prior }) => {
        seenPriors.push([...prior]);
        return { raw: decisions[n++] ?? "" };
      },
      streamAnswer: async function* () {
        yield "fallback answer";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => {
        throw new Error("docs index offline");
      },
      names: () => ["searchDocs"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit, events } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "what is acp" }, emit);

    // The run did NOT abort — the loop continued to the second decideAction
    // and streamed an answer. Pre-fix, the catch-block emitted `error` and
    // returned early.
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    const kinds = events.map((e: any) => e.params?.kind);
    expect(kinds).toContain("tool.failed");
    expect(kinds).toContain("answer.done");
    expect(kinds).not.toContain("error");

    // The second decideAction sees the failure encoded as a tool-result.
    const second = seenPriors[1] ?? [];
    const resultEntry = second.find((e) => e.kind === "tool-result") as
      | Extract<PriorEntry, { kind: "tool-result" }>
      | undefined;
    expect(resultEntry).toBeDefined();
    expect(resultEntry?.result).toEqual({ error: "docs index offline" });

    // tool.failure telemetry fires (distinct from tool.call so dashboards
    // can tell recoverable failures from a clean call).
    expect(tel.snapshot().some((e) => e.name === "tool.failure")).toBe(true);

    // The user-facing event carries both the tool name and the error
    // message so the UI can render a meaningful tool turn.
    const failed = events.find(
      // biome-ignore lint/suspicious/noExplicitAny: event-shape access
      (e: any) => e.params?.kind === "tool.failed",
    ) as { params: { tool: string; message: string } } | undefined;
    expect(failed?.params.tool).toBe("searchDocs");
    expect(failed?.params.message).toBe("docs index offline");
  });

  it("long searchDocs body is truncated with marker before reaching prior", async () => {
    const longBody = "a".repeat(2000);
    const decisions = [
      '{"kind":"tool","tool":"searchDocs","args":{"query":"x"}}',
      '{"kind":"answer","answerDraft":"ok"}',
    ];
    let n = 0;
    const seenPriors: PriorEntry[][] = [];
    const adapter: ModelAdapter = {
      decideAction: async ({ prior }) => {
        seenPriors.push([...prior]);
        return { raw: decisions[n++] ?? "" };
      },
      streamAnswer: async function* () {
        yield "ok";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({ hits: [{ heading: "h", text: longBody }] }),
      names: () => ["searchDocs"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "q" }, emit);

    const second = seenPriors[1] ?? [];
    const resultEntry = second.find((e) => e.kind === "tool-result") as
      | Extract<PriorEntry, { kind: "tool-result" }>
      | undefined;
    expect(resultEntry).toBeDefined();
    expect(resultEntry?.truncated).toBe(true);
    const result = resultEntry?.result as { hits: Array<{ text: string }> };
    expect(result.hits[0]?.text.length).toBeLessThanOrEqual(800 + " [... truncated]".length + 1);
    expect(result.hits[0]?.text).toContain("[... truncated]");
  });

  it("emits validation.failure telemetry and stops on invalid decide output", async () => {
    const adapter: ModelAdapter = {
      decideAction: async () => ({ raw: "not json at all" }),
      streamAnswer: async function* () {
        yield "x";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({}),
      names: () => ["searchDocs", "readCodeSnippet"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit, events } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "x" }, emit);

    expect(tel.snapshot().some((e) => e.name === "validation.failure")).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    expect(events.some((e: any) => e.params?.kind === "error")).toBe(true);
  });

  // ─── Cancel plumbing ─────────────────────────────────────────────────────

  it("cancel mid-streamAnswer emits {kind:'cancelled'} and suppresses answer.done", async () => {
    // Verify: (a) cancel during streamAnswer causes the loop to break the
    // for-await at its next iteration, (b) the loop emits {kind:"cancelled"}
    // instead of {kind:"answer.done"}, (c) the AbortSignal threaded through
    // to the adapter is the same one cancel() aborted.
    const seenSignals: AbortSignal[] = [];
    let signalAtCancel: AbortSignal | undefined;
    const adapter: ModelAdapter = {
      decideAction: async ({ signal }) => {
        if (signal) seenSignals.push(signal);
        return { raw: '{"kind":"answer","answerDraft":"hi"}' };
      },
      streamAnswer: async function* ({ signal }) {
        if (signal) seenSignals.push(signal);
        for (let i = 0; i < 100; i++) {
          if (signal?.aborted) break;
          yield `chunk-${i}`;
        }
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({}),
      names: () => ["searchDocs", "readCodeSnippet"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { events } = emitter();

    // Inject a cancel after the third answer.chunk lands. We piggyback on
    // emit because there's no public "after-yield" hook; this captures the
    // moment cancel() fires relative to the in-flight iterator.
    let chunkCount = 0;
    const wrappedEmit = (m: JsonRpcMessage) => {
      events.push(m);
      // biome-ignore lint/suspicious/noExplicitAny: event-shape access
      if ((m as any).params?.kind === "answer.chunk") {
        chunkCount += 1;
        if (chunkCount === 3) {
          signalAtCancel = seenSignals[seenSignals.length - 1];
          runner.cancel("s");
        }
      }
    };

    await runner.runPrompt({ sessionId: "s", input: "hi" }, wrappedEmit);

    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    const chunks = events.filter((e: any) => e.params?.kind === "answer.chunk");
    expect(chunks.length).toBe(3);
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    const cancelled = events.find((e: any) => e.params?.kind === "cancelled");
    expect(cancelled).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    const done = events.find((e: any) => e.params?.kind === "answer.done");
    expect(done).toBeUndefined();
    // The signal threaded into the adapter is the same one the loop
    // aborted: this is the structural assertion that `cancel(sessionId)`
    // really controls the in-flight call.
    expect(signalAtCancel).toBeDefined();
    expect(signalAtCancel?.aborted).toBe(true);
  });

  it("cancel before runPrompt iterates emits cancelled at the boundary check", async () => {
    // Tests the iteration-top defense: a cancel that races ahead of the
    // first decideAction call must short-circuit before any model work.
    let decideCalls = 0;
    const adapter: ModelAdapter = {
      decideAction: async () => {
        decideCalls += 1;
        return { raw: '{"kind":"answer","answerDraft":"hi"}' };
      },
      streamAnswer: async function* () {
        yield "hi";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({}),
      names: () => ["searchDocs"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit, events } = emitter();

    // Start the run, then cancel synchronously before the microtask that
    // would call decideAction resolves.
    const runPromise = runner.runPrompt({ sessionId: "s", input: "hi" }, emit);
    runner.cancel("s");
    await runPromise;

    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    expect(events.some((e: any) => e.params?.kind === "cancelled")).toBe(true);
    // The boundary check fires BEFORE decideAction's microtask resolves.
    // decideCalls may be 0 (purely synchronous) — assert ≤1 to be robust.
    expect(decideCalls).toBeLessThanOrEqual(1);
  });

  it("cancel for an unknown sessionId is a no-op (does not throw)", async () => {
    const adapter: ModelAdapter = {
      decideAction: async () => ({ raw: '{"kind":"answer","answerDraft":"hi"}' }),
      streamAnswer: async function* () {
        yield "hi";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({}),
      names: () => ["searchDocs"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });

    // Unknown session ids are ignored; cancel remains a no-op for misses.
    expect(() => runner.cancel("never-started")).not.toThrow();
  });

  it("threads AbortSignal through to decideAction on every iteration", async () => {
    // Each iteration of the meta-loop should pass the same signal
    // reference. If a future refactor accidentally creates a fresh
    // controller per iteration, cancel would only abort the last one.
    const seenSignals: Array<AbortSignal | undefined> = [];
    const decisions = [
      '{"kind":"tool","tool":"searchDocs","args":{"query":"acp"}}',
      '{"kind":"answer","answerDraft":"acp"}',
    ];
    let n = 0;
    const adapter: ModelAdapter = {
      decideAction: async ({ signal }) => {
        seenSignals.push(signal);
        return { raw: decisions[n++] ?? "" };
      },
      streamAnswer: async function* ({ signal }) {
        seenSignals.push(signal);
        yield "acp";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({}),
      names: () => ["searchDocs"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "hi" }, emit);

    // Two decideAction calls + one streamAnswer call = 3 signals observed,
    // all the same instance.
    expect(seenSignals.length).toBe(3);
    expect(seenSignals[0]).toBeDefined();
    expect(seenSignals[1]).toBe(seenSignals[0]);
    expect(seenSignals[2]).toBe(seenSignals[0]);
  });

  it("clears the controller registry after a successful run (no leak)", async () => {
    // Indirect: after a clean run, a subsequent cancel for that sessionId
    // is a no-op. If the registry still held the old controller, cancel()
    // would still call abort() on a settled controller (harmless but a
    // smell). This test pins the cleanup contract.
    const adapter: ModelAdapter = {
      decideAction: async () => ({ raw: '{"kind":"answer","answerDraft":"hi"}' }),
      streamAnswer: async function* () {
        yield "hi";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({}),
      names: () => ["searchDocs"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "hi" }, emit);

    // After cleanup, cancel() should find no entry and return silently.
    // We verify by observing that a follow-up runPrompt sees a fresh
    // signal that is NOT pre-aborted.
    let secondRunSignal: AbortSignal | undefined;
    const adapter2: ModelAdapter = {
      decideAction: async ({ signal }) => {
        secondRunSignal = signal;
        return { raw: '{"kind":"answer","answerDraft":"hi"}' };
      },
      streamAnswer: async function* () {
        yield "hi";
      },
    };
    const runner2 = createMetaAgentLoop({ adapter: adapter2, tools, telemetry: tel });
    await runner2.runPrompt({ sessionId: "s", input: "hi" }, emit);
    runner2.cancel("s"); // post-run cancel — no throw, no effect

    expect(secondRunSignal?.aborted).toBe(false);
  });

  it("decideAction failure degrades to a graceful answer.chunk + answer.done", async () => {
    const adapter: ModelAdapter = {
      decideAction: async () => {
        throw new Error("MessageOrderError: Last message should be from either `user` or `tool`.");
      },
      streamAnswer: async function* () {
        yield "should not reach";
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({}),
      names: () => ["searchDocs"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit, events } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "what is acp" }, emit);

    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    const kinds = events.map((e: any) => e.params?.kind);
    expect(kinds).toContain("answer.chunk");
    expect(kinds).toContain("answer.done");
    expect(kinds).not.toContain("error");
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    const chunk = events.find((e: any) => e.params?.kind === "answer.chunk");
    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    expect(String((chunk as any).params.text)).toContain("MessageOrderError");
    expect(tel.snapshot().some((e) => e.name === "decide.failure")).toBe(true);
  });

  it("streamAnswer failure mid-stream degrades to a closing chunk + answer.done", async () => {
    const adapter: ModelAdapter = {
      decideAction: async () => ({ raw: '{"kind":"answer","answerDraft":"hi"}' }),
      streamAnswer: async function* () {
        yield "partial ";
        throw new Error("device lost");
      },
    };
    const tools: LocalToolRegistry = {
      invoke: async () => ({}),
      names: () => ["searchDocs"],
    };
    const tel = createInMemoryTelemetry();
    const runner = createMetaAgentLoop({ adapter, tools, telemetry: tel });
    const { emit, events } = emitter();
    await runner.runPrompt({ sessionId: "s", input: "hi" }, emit);

    // biome-ignore lint/suspicious/noExplicitAny: event-shape access
    const kinds = events.map((e: any) => e.params?.kind);
    expect(kinds).toContain("answer.chunk");
    expect(kinds).toContain("answer.done");
    expect(kinds).not.toContain("error");
    const chunkTexts = events
      // biome-ignore lint/suspicious/noExplicitAny: event-shape access
      .filter((e: any) => e.params?.kind === "answer.chunk")
      // biome-ignore lint/suspicious/noExplicitAny: event-shape access
      .map((e: any) => String(e.params.text));
    expect(chunkTexts.some((t) => t.includes("partial"))).toBe(true);
    expect(chunkTexts.some((t) => t.includes("device lost"))).toBe(true);
    expect(tel.snapshot().some((e) => e.name === "stream.failure")).toBe(true);
  });
});

describe("truncateToolResult", () => {
  it("clips each searchDocs hit body at 800 chars and marks truncated", () => {
    const raw = {
      hits: [
        { heading: "a", text: "x".repeat(801) },
        { heading: "b", text: "short" },
      ],
    };
    const { value, truncated } = truncateToolResult(raw);
    expect(truncated).toBe(true);
    const v = value as { hits: Array<{ text: string }> };
    expect(v.hits[0]?.text).toContain("[... truncated]");
    expect(v.hits[0]?.text.startsWith("x".repeat(800))).toBe(true);
    expect(v.hits[1]?.text).toBe("short");
  });

  it("clips readCodeSnippet body at 2000 chars", () => {
    const raw = { path: "p.ts", text: "x".repeat(2001) };
    const { value, truncated } = truncateToolResult(raw);
    expect(truncated).toBe(true);
    const v = value as { text: string };
    expect(v.text).toContain("[... truncated]");
    expect(v.text.startsWith("x".repeat(2000))).toBe(true);
  });

  it("returns the raw value with truncated=false when nothing exceeds the budget", () => {
    const raw = { hits: [{ heading: "h", text: "small" }] };
    const { value, truncated } = truncateToolResult(raw);
    expect(truncated).toBe(false);
    expect(value).toEqual(raw);
  });

  it("passes through non-object inputs untouched", () => {
    expect(truncateToolResult(null)).toEqual({ value: null, truncated: false });
    expect(truncateToolResult(42)).toEqual({ value: 42, truncated: false });
    expect(truncateToolResult("hi")).toEqual({ value: "hi", truncated: false });
  });
});
