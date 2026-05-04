/**
 * Per-request AG-UI run session.
 *
 * Bridges a single `POST /agent` SSE stream to the shared
 * `GatewayHostController` — subscribes, pipes each event through the
 * pure translator, enforces the always-on `validateAguiEvent` gate, and
 * writes SSE frames to a `ReadableStream` controller. Resolves when the
 * run reaches a terminal state (`turn_completed` or `error`) or when
 * the caller aborts (client disconnect, `controller.cancel()`).
 *
 * All events emitted by the translator must pass validation before
 * being enqueued. If an event fails validation, we log and skip it —
 * invalid AG-UI wire frames are worse than missing ones.
 */
import type { ACPSessionEvent } from "@agents-js/acp-host";
import type { BaseEvent } from "@agents-js/agui-types";
import { EventType } from "@agents-js/agui-types";
import { validateAguiEvent } from "@agents-js/validation";
import { createTranslatorState, translateAcpEvent } from "./acp-to-agui-translator.ts";
import type { GatewayHostController } from "./host-session.ts";

const SSE_ENCODER = new TextEncoder();

export function formatAguiSseFrame(event: BaseEvent): Uint8Array {
  return SSE_ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Validate an AG-UI event and enqueue it as an SSE frame. Invalid
 * events are logged and dropped — the always-on validation gate is a
 * core contract, so silently skipping a bad frame is safer than
 * emitting garbage to the client.
 *
 * Shared between the endpoint (lifecycle events) and the per-run
 * subscription loop.
 */
export function enqueueAguiEvent(
  sink: ReadableStreamDefaultController<Uint8Array>,
  event: BaseEvent,
  logger: Pick<Console, "warn"> = console,
): void {
  const parsed = validateAguiEvent(event);
  if (!parsed.valid) {
    logger.warn("[Gateway/AG-UI] Dropping invalid AG-UI event", {
      error: parsed.error.message,
      type: (event as { type?: unknown }).type,
    });
    return;
  }
  try {
    sink.enqueue(formatAguiSseFrame(parsed.value));
  } catch (err) {
    logger.warn("[Gateway/AG-UI] Sink enqueue failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface RunSessionOptions {
  controller: Pick<GatewayHostController, "subscribe" | "sendPrompt" | "getState" | "newSession">;
  threadId: string;
  runId: string;
  /** Prompt text to forward to the ACP controller. */
  promptText: string;
  /** SSE sink — the run session pushes frames here. */
  sink: ReadableStreamDefaultController<Uint8Array>;
  /** Signal from the incoming HTTP request — resolves on client disconnect. */
  abortSignal?: AbortSignal;
  /** Optional logger override (for tests). */
  logger?: Pick<Console, "warn" | "error" | "log">;
}

/**
 * Result of running an AG-UI run session to completion.
 */
export interface RunSessionResult {
  /** `true` if we emitted RUN_FINISHED, `false` if RUN_ERROR. */
  finished: boolean;
  /** Stop reason surfaced by the ACP turn, when available. */
  stopReason?: string;
  /** Error message if `finished === false`. */
  errorMessage?: string;
}

/**
 * Run one AG-UI run from start to finish. Caller is responsible for
 * enqueuing the leading `RUN_STARTED` frame and closing the sink after
 * this promise resolves.
 *
 * Why the sink is injected rather than owned here: the HTTP handler
 * wants a single place that emits `RUN_STARTED` first and
 * `RUN_FINISHED`/`RUN_ERROR` last, and then closes the stream. Having
 * this helper "own" the sink would fragment that lifecycle.
 */
export async function runAguiSession(options: RunSessionOptions): Promise<RunSessionResult> {
  const { controller, threadId, runId, promptText, sink, abortSignal, logger = console } = options;

  const state = createTranslatorState();
  let terminal: RunSessionResult | null = null;
  let resolveDone!: (result: RunSessionResult) => void;
  const done = new Promise<RunSessionResult>((resolve) => {
    resolveDone = resolve;
  });

  function finalize(result: RunSessionResult) {
    if (terminal) return;
    terminal = result;
    resolveDone(result);
  }

  function emit(event: BaseEvent): void {
    enqueueAguiEvent(sink, event, logger);
  }

  const unsubscribe = controller.subscribe((event: ACPSessionEvent) => {
    if (terminal) return;

    // Surface errors as RUN_ERROR and finish.
    if (event.type === "error") {
      emit({
        type: EventType.RUN_ERROR,
        message: event.message,
      });
      finalize({ finished: false, errorMessage: event.message });
      return;
    }

    const translated = translateAcpEvent(event, state);
    for (const out of translated) {
      emit(out);
    }

    if (event.type === "turn_completed") {
      emit({
        type: EventType.RUN_FINISHED,
        threadId,
        runId,
      });
      finalize({ finished: true, stopReason: event.stopReason });
    }
  });

  // Wire the client disconnect → abort the ACP turn. We do NOT call
  // `controller.cancel()` ourselves unconditionally — the ACP host may
  // already be done, or the caller may have other policies. The caller
  // should pass `req.signal`, which lets us react to client disconnect.
  const onAbort = () => {
    if (terminal) return;
    finalize({
      finished: false,
      errorMessage: "client disconnected",
    });
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  // Kick off the prompt. If there is no active session yet, open one —
  // mirrors HostA2AExecutor.runPrompt().
  try {
    if (!controller.getState().sessionId) {
      await controller.newSession();
    }
    await controller.sendPrompt([{ type: "text", text: promptText }]);
  } catch (err) {
    if (!terminal) {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: EventType.RUN_ERROR,
        message,
      });
      finalize({ finished: false, errorMessage: message });
    }
  }

  // `sendPrompt` resolves when the agent turn completes, but the
  // `turn_completed` event can race — keep awaiting the `done` promise
  // to guarantee we've processed the terminal frame.
  try {
    return await done;
  } finally {
    unsubscribe();
    abortSignal?.removeEventListener("abort", onAbort);
  }
}
