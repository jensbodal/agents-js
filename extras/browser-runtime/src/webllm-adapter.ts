import { ACTION_SCHEMA, type Action } from "./action-schema.ts";
import type { LocalModel } from "./local-model.ts";
import type { ModelAdapter } from "./meta-agent-loop.ts";

/**
 * WebLLM grammar bridge: the C++/Embind binding behind XGrammar's
 * `CompileJSONSchema` requires the schema as a STRINGIFIED JSON blob, not
 * an object. WebLLM 0.2.82 invokes `compileJSONSchema(schema)` whenever
 * `response_format.type === "json_object"`, even when no schema is
 * supplied — the worker code defaults `schema` to an empty/undefined value
 * which the std::string binding rejects with `BindingError: Cannot pass
 * non-string to std::string`. Always providing the action schema as a
 * string both (a) prevents the binding error, and (b) gives us real
 * constrained generation instead of free-form JSON. Pre-computed once at
 * module load to avoid re-stringifying on every prompt.
 */
const ACTION_SCHEMA_JSON = JSON.stringify(ACTION_SCHEMA);

/**
 * Render prior actions as a footer for the user message body. Inlined into
 * the `user` role rather than emitted as a separate `assistant` message
 * because WebLLM (and OpenAI-compatible chat templates more broadly) reject
 * a completions request whose last message is `assistant` — the model needs
 * a `user` or `tool` message to know what to respond to. The proper fix
 * carries tool results in a typed structure and replays them via `tool`-role
 * messages; until then, this footer gives the model a hint of its own past
 * decisions while keeping the request well-formed.
 */
function serializePriorForUser(prior: Action[]): string {
  return JSON.stringify(prior);
}

/**
 * Wire an `AbortSignal` to WebLLM's backend cancel primitive.
 *
 * WebLLM 0.2.82's `ChatCompletionRequest` does NOT accept a `signal` field
 * the way the OpenAI Node SDK does (verified against the package's
 * `chat_completion.d.ts` — the request type is closed at `extra_body`).
 * The supported cancel API is `engine.interruptGenerate()`, which causes
 * the in-flight generation to settle with whatever has been produced so
 * far. We bridge `AbortSignal.abort` to that call here.
 *
 * The for-await loop in `streamAnswer` ALSO checks `signal.aborted` before
 * each yield; that is the synchronous belt-and-suspenders the unit test
 * pins, and is what guarantees the ≤300ms wall-clock cancel budget even if
 * the engine takes longer to honor `interruptGenerate`.
 */
function bridgeSignalToInterrupt(model: LocalModel, signal: AbortSignal | undefined): void {
  if (!signal) return;
  if (signal.aborted) {
    void model.engine.interruptGenerate();
    return;
  }
  signal.addEventListener(
    "abort",
    () => {
      void model.engine.interruptGenerate();
    },
    { once: true },
  );
}

/**
 * System prompt for `decideAction`. Includes the action schema verbatim
 * because small local models (1-3B params) routinely fabricate field names
 * when given only abstract instructions. Worked examples + an explicit
 * "no prose, no markdown fences" rule give the best chance of producing
 * a JSON object that survives `coerceAction` + Ajv `oneOf` validation.
 *
 * Exported so consumers (different docs sites, alternative product surfaces)
 * can reference, extend, or replace the default via
 * `createWebLLMAdapter(model, { decideSystemPrompt })`.
 */
// TODO(decide-schema-drift): worked examples below mirror the shapes in
// `action-schema.ts`. If the schema changes, both must be updated together.
// Consider generating examples from `ACTION_SCHEMA` at build time to remove
// the drift risk.
export const DEFAULT_DECIDE_SYSTEM_PROMPT = `You are a docs-search agent. Reply with EXACTLY ONE JSON object describing the next action — no prose, no markdown fences.

The JSON object MUST be one of these four shapes (and nothing else):

1. Call a tool to look something up:
   {"kind":"tool","tool":"searchDocs","args":{"query":"<question>","topK":3}}
   {"kind":"tool","tool":"readCodeSnippet","args":{"path":"<path>","symbol":"<name>"}}

2. Stream a final answer to the user:
   {"kind":"answer","answerDraft":"<your full answer here>"}

3. Ask the user to clarify an ambiguous question:
   {"kind":"clarify","clarifyPrompt":"<a short clarifying question>"}

4. Report that you cannot help:
   {"kind":"error","errorMessage":"<short reason>"}

Rules:
- Pick exactly one shape. Do NOT mix fields between shapes.
- "kind" is required and must be one of: "tool", "answer", "clarify", "error".
- "additionalProperties: false" — only the fields listed above are allowed for each kind.
- Use \`searchDocs\` first when the user asks a docs question; use \`readCodeSnippet\` when they ask about a specific file/symbol; reply with \`answer\` after at most one tool call.`;

export interface CreateWebLLMAdapterOptions {
  /**
   * Override the system prompt used by `decideAction`. Defaults to
   * `DEFAULT_DECIDE_SYSTEM_PROMPT`. Consumers with a different action
   * vocabulary or product persona can pass their own.
   */
  readonly decideSystemPrompt?: string;
}

/**
 * Build a `ModelAdapter` backed by an already-loaded WebLLM `LocalModel`.
 *
 * Extracted from the docs VitePress wrapper so the WebLLM-specific message
 * construction (system + user + prior assistant) can be unit-tested with a
 * fake `MLCEngineInterface`. The adapter only touches `model.engine.chat`
 * and `model.engine.interruptGenerate`; the worker handle is left to the
 * caller to manage.
 *
 * Both methods accept an optional `AbortSignal`. `streamAnswer` checks
 * `signal.aborted` before each yield and breaks out within one microtask tick.
 * Both methods register a one-shot abort listener that calls
 * `engine.interruptGenerate()` so the underlying WebLLM worker stops doing
 * real work; without this, the model would keep producing tokens that the
 * consumer immediately discards.
 *
 * Configurable surface: `options.decideSystemPrompt` overrides the default
 * decide-action system prompt. The options bag is reserved for future
 * additive lifts (temperature, response_format, etc.).
 */
export function createWebLLMAdapter(
  model: LocalModel,
  options: CreateWebLLMAdapterOptions = {},
): ModelAdapter {
  const decideSystemPrompt = options.decideSystemPrompt ?? DEFAULT_DECIDE_SYSTEM_PROMPT;
  return {
    async decideAction({ sessionInput, prior, signal }) {
      bridgeSignalToInterrupt(model, signal);
      const userContent =
        prior.length === 0
          ? sessionInput
          : `${sessionInput}\n\n[Previous actions you took: ${serializePriorForUser(prior)}]`;
      const messages: Array<{ role: "system" | "user"; content: string }> = [
        { role: "system", content: decideSystemPrompt },
        { role: "user", content: userContent },
      ];
      const completion = await model.engine.chat.completions.create({
        messages,
        // schema must be the STRINGIFIED JSON Schema — see ACTION_SCHEMA_JSON
        // module-doc above for why this is mandatory in WebLLM 0.2.82.
        response_format: { type: "json_object", schema: ACTION_SCHEMA_JSON },
        temperature: 0,
      });
      return { raw: completion.choices[0]?.message?.content ?? "" };
    },
    async *streamAnswer({ sessionInput, prior, signal }) {
      bridgeSignalToInterrupt(model, signal);
      // TODO(streamAnswer-tool-role): we currently echo prior tool *calls*
      // (tool name + args), NOT tool results — `Action` doesn't carry a
      // `result` field, and `meta-agent-loop.ts` invokes tools but never
      // writes the result back into `prior`. Real fix: extend the loop to
      // capture tool results and pass them via {role:"tool", content:...}
      // messages here. Until then, echoing the call gives the model some
      // contextual hint without claiming the docs were actually injected.
      const toolCalls = prior
        .filter((a) => a.kind === "tool")
        .map((a) => `Called ${a.tool} with ${JSON.stringify(a.args)}`)
        .join("\n");
      const userContent = toolCalls
        ? `${sessionInput}\n\n(Prior tool calls:\n${toolCalls})`
        : sessionInput;
      const stream = await model.engine.chat.completions.create({
        messages: [{ role: "user", content: userContent }],
        stream: true,
      });
      for await (const chunk of stream) {
        if (signal?.aborted) break;
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    },
  };
}
