import type { PriorEntry } from "./action-schema.ts";
import { coerceAction } from "./action-validator.ts";
import type { JsonRpcMessage, PromptParams, PromptRunner } from "./browser-acp-shim.ts";
import type { Telemetry } from "./telemetry.ts";
import type { LocalToolRegistry } from "./tool-registry.ts";

export interface DecideResult {
  raw: string;
}

/**
 * Truncation budget for tool results before they're written into `prior`.
 * Keeps the next-iteration prompt from blowing past a small local model's
 * context window when a single `searchDocs` hit happens to embed a long
 * passage. The marker is added inline so the model can tell its context
 * is not verbatim.
 */
const PER_HIT_BODY = 800;
const PER_SNIPPET_BODY = 2000;
const TRUNCATION_MARK = "[... truncated]";

/**
 * Clip oversized text inside a tool result to keep the next prompt small.
 *
 * Two shapes are handled, matching what `default-tools.ts` actually returns:
 * - `searchDocs` → `{ hits: [{ ..., text: "..." }, ...] }`. Each hit's `text`
 *   is clipped to {@link PER_HIT_BODY}.
 * - `readCodeSnippet` → `{ ..., text: "..." }`. The single `text` is clipped
 *   to {@link PER_SNIPPET_BODY}.
 *
 * Anything else is returned verbatim with `truncated: false`. Returning the
 * raw value rather than an `as any` cast keeps the type-guard local; callers
 * see a plain `unknown`.
 */
export function truncateToolResult(raw: unknown): {
  value: unknown;
  truncated: boolean;
} {
  let truncated = false;
  const clip = (s: string, n: number): string => {
    if (s.length <= n) return s;
    truncated = true;
    return `${s.slice(0, n)} ${TRUNCATION_MARK}`;
  };
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.hits)) {
      const hits = r.hits.map((h) => {
        if (h && typeof h === "object" && typeof (h as { text?: unknown }).text === "string") {
          return {
            ...(h as object),
            text: clip((h as { text: string }).text, PER_HIT_BODY),
          };
        }
        return h;
      });
      return { value: { ...r, hits }, truncated };
    }
    if (typeof r.text === "string") {
      return {
        value: { ...r, text: clip(r.text, PER_SNIPPET_BODY) },
        truncated,
      };
    }
  }
  return { value: raw, truncated };
}

/**
 * Adapter contract between the meta-agent loop and an LLM backend.
 *
 * The optional `signal` field on each method's input is the cancellation
 * primitive: the loop owns one `AbortController` per session, threads
 * `controller.signal` through every call, and aborts on `cancel(sessionId)`.
 * Adapters MUST honor the signal — `streamAnswer` by short-circuiting its
 * async iterator within one tick of `signal.aborted`, `decideAction` by
 * propagating any backend-level abort (e.g. WebLLM's `interruptGenerate`).
 *
 * Why a per-call signal rather than a single per-adapter signal: a single
 * adapter instance services many sessions. Per-call signal scopes cancel to
 * one prompt, leaving sibling sessions untouched.
 */
export interface ModelAdapter {
  decideAction(input: {
    sessionInput: string;
    prior: PriorEntry[];
    signal?: AbortSignal;
  }): Promise<DecideResult>;
  streamAnswer(input: {
    sessionInput: string;
    prior: PriorEntry[];
    signal?: AbortSignal;
  }): AsyncIterable<string>;
}

export interface MetaAgentLoopDeps {
  adapter: ModelAdapter;
  tools: LocalToolRegistry;
  telemetry: Telemetry;
  maxToolCalls?: number;
}

export function createMetaAgentLoop(deps: MetaAgentLoopDeps): PromptRunner {
  // Per-session AbortController registry. Callers get a fresh controller per
  // `runPrompt`, `cancel(sessionId)` calls `abort()` on the matching entry, and
  // the in-flight adapter call short-circuits within one tick.
  const controllers = new Map<string, AbortController>();
  return {
    cancel(sessionId) {
      const controller = controllers.get(sessionId);
      if (!controller) return;
      controller.abort();
      controllers.delete(sessionId);
    },
    async runPrompt(params: PromptParams, emit: (m: JsonRpcMessage) => void) {
      const prior: PriorEntry[] = [];
      const maxToolCalls = deps.maxToolCalls ?? 3;

      // If a stale controller is still registered for this sessionId (e.g.
      // a re-prompt before the previous run finished), replacing it leaves
      // the old in-flight call to settle on its own — its emits may still
      // race onto the bus, but the new run owns the abort signal going
      // forward. The previous controller is intentionally NOT aborted: the
      // shim semantics treat each runPrompt as independent.
      const controller = new AbortController();
      controllers.set(params.sessionId, controller);
      const signal = controller.signal;

      try {
        for (let i = 0; i < maxToolCalls; i++) {
          if (signal.aborted) {
            emit({ jsonrpc: "2.0", method: "session/update", params: { kind: "cancelled" } });
            return;
          }
          let decision: DecideResult;
          try {
            decision = await deps.adapter.decideAction({
              sessionInput: params.input,
              prior,
              signal,
            });
          } catch (err) {
            // The model rejected the request (bad message format, context
            // overflow, device loss, etc.). Don't surface a raw `RUN_ERROR`;
            // emit a graceful answer chunk so the user sees a coherent reply
            // instead of an opaque trace error. The trace still records the
            // failure via telemetry below.
            const reason = (err as Error).message || "unknown model error";
            deps.telemetry.emit({ name: "decide.failure", attrs: { reason } });
            emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                kind: "answer.chunk",
                text: `I couldn't continue this run because the local model rejected the request: ${reason}. Try rephrasing the question or starting a new run.`,
              },
            });
            emit({ jsonrpc: "2.0", method: "session/update", params: { kind: "answer.done" } });
            return;
          }
          if (signal.aborted) {
            emit({ jsonrpc: "2.0", method: "session/update", params: { kind: "cancelled" } });
            return;
          }
          const validated = coerceAction(decision.raw);
          if (!validated.valid || !validated.data) {
            deps.telemetry.emit({
              name: "validation.failure",
              attrs: { errors: validated.errors },
            });
            emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: { kind: "error", message: "invalid action JSON" },
            });
            return;
          }

          const action = validated.data;
          prior.push(action);

          if (action.kind === "tool") {
            deps.telemetry.emit({ name: "tool.call", attrs: { tool: action.tool } });
            try {
              const result = await deps.tools.invoke(action.tool, action.args);
              const { value, truncated } = truncateToolResult(result);
              prior.push({
                kind: "tool-result",
                tool: action.tool,
                args: action.args,
                result: value,
                truncated,
              });
              emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: { kind: "tool.invoked", tool: action.tool, result },
              });
              continue;
            } catch (err) {
              // Tool failures are recoverable: write the error into `prior`
              // so the next decideAction sees the failure and can pick a
              // different action, and emit `tool.failed` so the UI can
              // distinguish a recoverable tool flake from a terminal run
              // error. This loop iteration falls through to `continue`.
              const message = (err as Error).message || "tool failed";
              prior.push({
                kind: "tool-result",
                tool: action.tool,
                args: action.args,
                result: { error: message },
              });
              deps.telemetry.emit({
                name: "tool.failure",
                attrs: { tool: action.tool, message },
              });
              emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: { kind: "tool.failed", tool: action.tool, message },
              });
              continue;
            }
          }

          if (action.kind === "answer") {
            try {
              for await (const chunk of deps.adapter.streamAnswer({
                sessionInput: params.input,
                prior,
                signal,
              })) {
                if (signal.aborted) break;
                emit({
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: { kind: "answer.chunk", text: chunk },
                });
              }
            } catch (err) {
              // Same defense as `decideAction`: a streaming failure should
              // produce a graceful answer rather than RUN_ERROR. Drop a
              // closing chunk + answer.done so the UI exits the streaming
              // state cleanly.
              const reason = (err as Error).message || "unknown model error";
              deps.telemetry.emit({ name: "stream.failure", attrs: { reason } });
              emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  kind: "answer.chunk",
                  text: `\n\n(The local model failed mid-answer: ${reason}.)`,
                },
              });
              emit({ jsonrpc: "2.0", method: "session/update", params: { kind: "answer.done" } });
              return;
            }
            // After the for-await drains, treat an aborted signal as a
            // cancel (NOT answer.done). Without this guard, a cancel that
            // arrived while the inner adapter loop was between yields would
            // emit `answer.done` and the consumer would never see
            // `cancelled`.
            if (signal.aborted) {
              emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: { kind: "cancelled" },
              });
              return;
            }
            emit({ jsonrpc: "2.0", method: "session/update", params: { kind: "answer.done" } });
            return;
          }

          if (action.kind === "clarify") {
            emit({
              jsonrpc: "2.0",
              method: "session/update",
              params: { kind: "clarify", prompt: action.clarifyPrompt },
            });
            return;
          }

          emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: { kind: "error", message: action.errorMessage },
          });
          return;
        }

        emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: { kind: "error", message: "tool budget exceeded" },
        });
      } finally {
        // Only clear the controller if this run still owns the slot. A
        // concurrent `runPrompt` for the same sessionId would have replaced
        // the entry; deleting unconditionally would orphan its abort hook.
        if (controllers.get(params.sessionId) === controller) {
          controllers.delete(params.sessionId);
        }
      }
    },
  };
}
