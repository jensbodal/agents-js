import { describe, expect, it } from "bun:test";
import type { MLCEngineInterface } from "@mlc-ai/web-llm";
import { ACTION_SCHEMA, type Action } from "./action-schema.ts";
import type { LocalModel } from "./local-model.ts";
import { createWebLLMAdapter, DEFAULT_DECIDE_SYSTEM_PROMPT } from "./webllm-adapter.ts";

interface CreateCall {
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  response_format?: unknown;
  temperature?: number;
}

interface FakeModelHandle {
  model: LocalModel;
  calls: CreateCall[];
  interruptCount: { value: number };
}

/**
 * Build a `LocalModel` whose engine.chat.completions.create is a programmable
 * fake. Test fakes are an acceptable place for `as unknown as MLCEngineInterface`
 * — we only need to satisfy the `chat` + `interruptGenerate` shape the adapter
 * actually touches. `interruptCount` lets cancel tests assert that the
 * `bridgeSignalToInterrupt` wiring fired.
 */
function makeFakeModel(create: (args: CreateCall) => unknown): FakeModelHandle {
  const calls: CreateCall[] = [];
  const interruptCount = { value: 0 };
  const fakeEngine = {
    chat: {
      completions: {
        create: async (args: CreateCall) => {
          calls.push(args);
          return create(args);
        },
      },
    },
    interruptGenerate: async () => {
      interruptCount.value += 1;
    },
  } as unknown as MLCEngineInterface;
  const model: LocalModel = {
    engine: fakeEngine,
    // Adapter never touches the worker; a bare object cast is sufficient.
    worker: {} as Worker,
  };
  return { model, calls, interruptCount };
}

describe("createWebLLMAdapter", () => {
  it("decideAction system prompt names the four schema kinds", async () => {
    // Pin the system-prompt contract: the model must see all four valid
    // action shapes by name. Drift in `DECIDE_SYSTEM_PROMPT` that drops one
    // kind would silently regress the meta-agent loop's ability to take
    // that path; this test is the regression net.
    const { model, calls } = makeFakeModel(() => ({
      choices: [{ message: { content: '{"kind":"answer","answerDraft":"hi"}' } }],
    }));
    const adapter = createWebLLMAdapter(model);

    await adapter.decideAction({ sessionInput: "what is acp", prior: [] });

    const systemContent = String(calls[0]?.messages[0]?.content ?? "");
    expect(calls[0]?.messages[0]?.role).toBe("system");
    for (const fieldName of ["searchDocs", "answerDraft", "clarifyPrompt", "errorMessage"]) {
      expect(systemContent).toContain(fieldName);
    }
    // The response_format MUST carry a stringified JSON Schema. WebLLM
    // 0.2.82's XGrammar binding rejects non-string schemas with
    // `BindingError: Cannot pass non-string to std::string`; passing
    // ACTION_SCHEMA as a JSON.stringify'd blob both fixes the binding
    // error AND gives us real constrained generation. See the module-doc
    // comment on ACTION_SCHEMA_JSON in webllm-adapter.ts.
    const responseFormat = calls[0]?.response_format as
      | { type: string; schema?: unknown }
      | undefined;
    expect(responseFormat?.type).toBe("json_object");
    expect(typeof responseFormat?.schema).toBe("string");
    expect(JSON.parse(String(responseFormat?.schema))).toEqual(
      JSON.parse(JSON.stringify(ACTION_SCHEMA)),
    );
    expect(calls[0]?.temperature).toBe(0);
  });

  it("decideAction includes prior actions as an assistant message when non-empty", async () => {
    const prior: Action[] = [{ kind: "tool", tool: "searchDocs", args: { query: "acp" } }];
    const { model, calls } = makeFakeModel(() => ({
      choices: [{ message: { content: '{"kind":"answer","answerDraft":"hi"}' } }],
    }));
    const adapter = createWebLLMAdapter(model);

    await adapter.decideAction({ sessionInput: "what is acp", prior });

    const assistantMsg = calls[0]?.messages.find((m) => m.role === "assistant");
    expect(assistantMsg?.content).toContain("searchDocs");
    expect(assistantMsg?.content).toContain("acp");
  });

  it("decideAction omits the assistant message when prior is empty", async () => {
    const { model, calls } = makeFakeModel(() => ({
      choices: [{ message: { content: '{"kind":"answer","answerDraft":"hi"}' } }],
    }));
    const adapter = createWebLLMAdapter(model);

    await adapter.decideAction({ sessionInput: "x", prior: [] });

    expect(calls[0]?.messages.some((m) => m.role === "assistant")).toBe(false);
  });

  it("decideAction returns empty string when content is missing", async () => {
    const { model } = makeFakeModel(() => ({ choices: [{ message: {} }] }));
    const adapter = createWebLLMAdapter(model);

    const result = await adapter.decideAction({ sessionInput: "x", prior: [] });

    expect(result.raw).toBe("");
  });

  it("decideAction returns empty string when choices is empty", async () => {
    const { model } = makeFakeModel(() => ({ choices: [] }));
    const adapter = createWebLLMAdapter(model);

    const result = await adapter.decideAction({ sessionInput: "x", prior: [] });

    expect(result.raw).toBe("");
  });

  it("streamAnswer yields each non-empty delta chunk and skips empty/null chunks", async () => {
    const chunks = [
      { choices: [{ delta: { content: "hello " } }] },
      { choices: [{ delta: { content: "" } }] },
      { choices: [{ delta: { content: null } }] },
      { choices: [{ delta: {} }] },
      { choices: [{ delta: { content: "world" } }] },
    ];
    async function* fakeStream() {
      for (const c of chunks) yield c;
    }
    const { model, calls } = makeFakeModel(() => fakeStream());
    const adapter = createWebLLMAdapter(model);

    const collected: string[] = [];
    for await (const piece of adapter.streamAnswer({ sessionInput: "hi", prior: [] })) {
      collected.push(piece);
    }

    expect(collected).toEqual(["hello ", "world"]);
    expect(calls.length).toBe(1);
    expect(calls[0]?.stream).toBe(true);
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("streamAnswer echoes prior tool calls into the user message when prior is non-empty", async () => {
    const prior: Action[] = [{ kind: "tool", tool: "searchDocs", args: { query: "what is acp" } }];
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "ok" } }] };
    }
    const { model, calls } = makeFakeModel(() => fakeStream());
    const adapter = createWebLLMAdapter(model);

    for await (const _ of adapter.streamAnswer({ sessionInput: "hi", prior })) {
      /* drain */
    }

    const userContent = String(calls[0]?.messages[0]?.content ?? "");
    expect(userContent).toContain("hi");
    expect(userContent).toContain("searchDocs");
    expect(userContent).toContain("Prior tool calls");
  });

  // ─── Cancel plumbing ─────────────────────────────────────────────────────

  it("streamAnswer stops yielding within one tick of signal abort (1000-chunk fake)", async () => {
    // The wall-clock contract is "≤300ms cancel". The unit-level contract
    // is stronger: the for-await must short-circuit synchronously in the
    // microtask immediately after `controller.abort()`. With a 1000-chunk
    // fake stream, asserting an exact stop count proves the boundary check
    // — not a wall-clock budget.
    const TOTAL_CHUNKS = 1000;
    const FAKE_CONTENTS: string[] = Array.from({ length: TOTAL_CHUNKS }, (_, i) => `c${i}`);
    async function* fakeStream() {
      for (const content of FAKE_CONTENTS) {
        yield { choices: [{ delta: { content } }] };
      }
    }
    const { model, interruptCount } = makeFakeModel(() => fakeStream());
    const adapter = createWebLLMAdapter(model);
    const controller = new AbortController();

    const collected: string[] = [];
    for await (const piece of adapter.streamAnswer({
      sessionInput: "hi",
      prior: [],
      signal: controller.signal,
    })) {
      collected.push(piece);
      if (collected.length === 5) controller.abort();
    }

    // Belt-and-suspenders boundary check stops the next iteration. Five
    // chunks observed before abort, none after — the 6th iteration's
    // signal.aborted check breaks before the next yield reaches the
    // consumer.
    expect(collected).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    // interruptGenerate was called via the abort listener.
    expect(interruptCount.value).toBe(1);
  });

  it("streamAnswer wires signal abort to engine.interruptGenerate even if abort fires before iteration starts", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "x" } }] };
    }
    const { model, interruptCount } = makeFakeModel(() => fakeStream());
    const adapter = createWebLLMAdapter(model);
    const controller = new AbortController();
    controller.abort();

    const iter = adapter.streamAnswer({
      sessionInput: "hi",
      prior: [],
      signal: controller.signal,
    });
    // Drain — no chunks reach the consumer when the signal is pre-aborted:
    // the `if (signal?.aborted) break` guard at the TOP of each iteration
    // short-circuits before any `yield delta` runs. The pre-abort bridge
    // also fires `interruptGenerate` synchronously on call, asserted below.
    for await (const _ of iter) {
      /* drain */
    }

    expect(interruptCount.value).toBe(1);
  });

  it("decideAction passes signal through and triggers interruptGenerate on abort", async () => {
    // For non-streaming `decideAction` the cancel mechanism is delegated
    // entirely to the engine's interruptGenerate. The adapter's contract
    // is "register the bridge"; the loop's iteration-boundary check is what
    // discards a partial decode.
    const { model, interruptCount } = makeFakeModel(() => ({
      choices: [{ message: { content: '{"kind":"answer","answerDraft":"hi"}' } }],
    }));
    const adapter = createWebLLMAdapter(model);
    const controller = new AbortController();

    const promise = adapter.decideAction({
      sessionInput: "hi",
      prior: [],
      signal: controller.signal,
    });
    controller.abort();
    await promise;

    expect(interruptCount.value).toBe(1);
  });

  it("decideAction uses DEFAULT_DECIDE_SYSTEM_PROMPT when no override is supplied", async () => {
    // Ties the default-path callers to the exported constant — drift in the
    // default prompt without updating consumers shows up here.
    const { model, calls } = makeFakeModel(() => ({
      choices: [{ message: { content: '{"kind":"answer","answerDraft":"hi"}' } }],
    }));
    const adapter = createWebLLMAdapter(model);

    await adapter.decideAction({ sessionInput: "hi", prior: [] });

    expect(calls[0]?.messages[0]?.content).toBe(DEFAULT_DECIDE_SYSTEM_PROMPT);
  });

  it("decideAction uses options.decideSystemPrompt when supplied", async () => {
    // Consumer-supplied prompt should fully replace the default.
    const customPrompt = "You are a strict JSON-only assistant for the Pi fleet.";
    const { model, calls } = makeFakeModel(() => ({
      choices: [{ message: { content: '{"kind":"answer","answerDraft":"hi"}' } }],
    }));
    const adapter = createWebLLMAdapter(model, { decideSystemPrompt: customPrompt });

    await adapter.decideAction({ sessionInput: "hi", prior: [] });

    expect(calls[0]?.messages[0]?.role).toBe("system");
    expect(calls[0]?.messages[0]?.content).toBe(customPrompt);
    expect(calls[0]?.messages[0]?.content).not.toContain("docs-search agent");
  });

  it("streamAnswer without a signal still works (signal is optional)", async () => {
    async function* fakeStream() {
      yield { choices: [{ delta: { content: "a" } }] };
      yield { choices: [{ delta: { content: "b" } }] };
    }
    const { model, interruptCount } = makeFakeModel(() => fakeStream());
    const adapter = createWebLLMAdapter(model);

    const collected: string[] = [];
    for await (const piece of adapter.streamAnswer({ sessionInput: "hi", prior: [] })) {
      collected.push(piece);
    }

    expect(collected).toEqual(["a", "b"]);
    expect(interruptCount.value).toBe(0);
  });
});
