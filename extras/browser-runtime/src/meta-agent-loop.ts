import type { Action } from "./action-schema.ts";
import { coerceAction } from "./action-validator.ts";
import type { JsonRpcMessage, PromptParams, PromptRunner } from "./browser-acp-shim.ts";
import type { Telemetry } from "./telemetry.ts";
import type { LocalToolRegistry } from "./tool-registry.ts";

export interface DecideResult {
  raw: string;
}

/**
 * Adapter contract between the meta-agent loop and an LLM backend.
 *
 * The optional `signal` field on each method's input is the M6 cancel
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
    prior: Action[];
    signal?: AbortSignal;
  }): Promise<DecideResult>;
  streamAnswer(input: {
    sessionInput: string;
    prior: Action[];
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
  // Per-session AbortController registry. M6 replaces the prior
  // `cancellations: Set<string>` flag with a real cancel primitive: callers
  // get a fresh controller per `runPrompt`, `cancel(sessionId)` calls
  // `abort()` on the matching entry, and the in-flight adapter call
  // short-circuits within one tick.
  const controllers = new Map<string, AbortController>();
  return {
    cancel(sessionId) {
      const controller = controllers.get(sessionId);
      if (!controller) return;
      controller.abort();
      controllers.delete(sessionId);
    },
    async runPrompt(params: PromptParams, emit: (m: JsonRpcMessage) => void) {
      const prior: Action[] = [];
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
          const decision = await deps.adapter.decideAction({
            sessionInput: params.input,
            prior,
            signal,
          });
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
              emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: { kind: "tool.invoked", tool: action.tool, result },
              });
              continue;
            } catch (err) {
              emit({
                jsonrpc: "2.0",
                method: "session/update",
                params: { kind: "error", message: (err as Error).message },
              });
              return;
            }
          }

          if (action.kind === "answer") {
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
