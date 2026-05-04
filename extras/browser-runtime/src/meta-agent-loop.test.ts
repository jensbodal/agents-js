import { describe, expect, it } from "bun:test";
import type { JsonRpcMessage } from "./browser-acp-shim.ts";
import { createMetaAgentLoop, type ModelAdapter } from "./meta-agent-loop.ts";
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
    const adapter: ModelAdapter = {
      decideAction: async () => ({ raw: decisions[n++] ?? "" }),
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

    // Pre-M6 the loop tracked a Set and silently added unknown ids; the new
    // controllers Map ignores misses. Either way, no throw.
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
});
