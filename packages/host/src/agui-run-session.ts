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
  controller: Pick<
    GatewayHostController,
    "cancel" | "subscribe" | "sendPrompt" | "getState" | "newSession"
  >;
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

    // Surface errors as RUN_ERROR and finish. The upstream
    // RunErrorEvent schema is `.passthrough()` so attaching the
    // run identity is permitted; the reviewer flagged that error
    // frames previously omitted them, breaking client-side
    // correlation between a failed run and its origin.
    if (event.type === "error") {
      emit({
        type: EventType.RUN_ERROR,
        message: event.message,
        threadId,
        runId,
      } as BaseEvent);
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

  // Wire the client disconnect → cancel the ACP turn. AG-UI is the
  // primary browser run surface; closing the SSE stream means the
  // operator no longer wants the run to continue, so we cancel the
  // controller turn and emit a terminal RUN_ERROR to any still-
  // connected observer (programmatic readers can call reader.cancel()
  // without dropping the underlying HTTP connection — they will see
  // the error frame on whatever they wired up).
  //
  // **Awaits the cancel before finalizing.** The endpoint's run
  // coordinator releases its lease in the start() finally block,
  // which only runs after `done` resolves. If we fire-and-forgot the
  // cancel here, the lease would be released while the controller is
  // still draining its previous turn — and the next `POST /agent`
  // would acquire the slot before the previous run had truly
  // unwound. The await closes that race.
  //
  // The cancel is still best-effort: the controller may already be
  // idle, and we swallow throwing cancel implementations because the
  // run is unwinding regardless.
  const onAbort = async (): Promise<void> => {
    if (terminal) return;
    const message = "run canceled by disconnect";
    emit({
      type: EventType.RUN_ERROR,
      message,
      threadId,
      runId,
    } as BaseEvent);
    try {
      await controller.cancel?.();
    } catch (err: unknown) {
      logger.warn("[Gateway/AG-UI] controller.cancel() during disconnect threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Finalize AFTER the cancel resolves so `done` does not settle
    // until the controller has actually unwound the prior turn.
    finalize({ finished: false, errorMessage: message });
  };
  // Wrap the listener: AbortSignal.addEventListener cannot await async
  // handlers, so we capture the in-flight promise on a closure variable
  // and the run-session's `done` await will join it transitively
  // through `finalize`.
  let inFlightAbort: Promise<void> | null = null;
  const abortListener = (): void => {
    inFlightAbort = onAbort();
  };
  abortSignal?.addEventListener("abort", abortListener, { once: true });

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
        threadId,
        runId,
      } as BaseEvent);
      finalize({ finished: false, errorMessage: message });
    }
  }

  // `sendPrompt` resolves when the agent turn completes, but the
  // `turn_completed` event can race — keep awaiting the `done` promise
  // to guarantee we've processed the terminal frame.
  try {
    const result = await done;
    // If a disconnect was observed during the run, the abort listener
    // captured an in-flight cancel promise. Await it before returning
    // so the endpoint's lease release waits for the cancel to settle.
    if (inFlightAbort !== null) {
      await inFlightAbort;
    }
    return result;
  } finally {
    unsubscribe();
    abortSignal?.removeEventListener("abort", abortListener);
  }
}
