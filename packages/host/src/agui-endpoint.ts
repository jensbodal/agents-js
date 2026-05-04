/**
 * HTTP handler for `POST /agent` — the native AG-UI server endpoint.
 *
 * Extracts the last user-text from `RunAgentInput.messages`, opens an
 * SSE stream, wraps the run in `RUN_STARTED` / `RUN_FINISHED` /
 * `RUN_ERROR`, and delegates the interior of the run to
 * `runAguiSession`.
 *
 * Lifecycle contract:
 * - first event = `RUN_STARTED` with `threadId` / `runId`
 * - terminal event = `RUN_FINISHED` or `RUN_ERROR`
 * - nothing is emitted after the terminal event, and the stream closes
 *   server-side immediately after.
 *
 * Errors:
 * - invalid `RunAgentInput` body → 400 (Bad Request) + `{ error, issues }` JSON
 * - missing `Accept: text/event-stream` header → 406 (Not Acceptable)
 */
import { HTTP_STATUS } from "@agents-js/a2a";
import type { RunAgentInput } from "@agents-js/agui-types";
import { EventType } from "@agents-js/agui-types";
import { validateRunAgentInput } from "@agents-js/validation";
import { AguiRunBusyError, AguiRunCoordinator } from "./agui-run-coordinator.ts";
import { enqueueAguiEvent, runAguiSession } from "./agui-run-session.ts";
import type { AuditEmitter } from "./audit.ts";
import { newCorrelationId } from "./audit.ts";
import type { GatewayHostController } from "./host-session.ts";

const SSE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const JSON_HEADERS = { "Content-Type": "application/json" };

export interface AguiEndpointOptions {
  controller: Pick<
    GatewayHostController,
    "cancel" | "subscribe" | "sendPrompt" | "getState" | "newSession"
  >;
  /** Request path that triggers this handler. Defaults to `/agent`. */
  path?: string;
  logger?: Pick<Console, "warn" | "error" | "log">;
  /**
   * Run coordinator enforcing single-active-run behavior. Defaults to
   * a fresh in-process coordinator — pass an explicit instance when
   * the gateway needs to share the gate with other surfaces (e.g. a
   * future per-thread coordinator registry).
   */
  coordinator?: AguiRunCoordinator;
  /**
   * Optional audit emitter. When provided, the endpoint records
   * lifecycle events (start, finish, error, disconnect-cancel) with a
   * correlation ID stable across the run. Audit records carry only
   * structural metadata — never prompt bodies, env values, or the
   * server-supplied error message verbatim.
   */
  audit?: AuditEmitter;
}

/**
 * Build a `(req: Request) => Promise<Response | null>` handler suitable
 * for `UniversalA2AServerOptions.additionalFetch`. Returns `null` when
 * the request is not for this handler — the caller then falls through
 * to the next layer (JSON-RPC, 404, etc.).
 */
export function createAguiFetchHandler(
  options: AguiEndpointOptions,
): (req: Request) => Promise<Response | null> {
  const path = options.path ?? "/agent";
  const logger = options.logger ?? console;
  const coordinator = options.coordinator ?? new AguiRunCoordinator();

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== path) {
      return null;
    }
    if (req.method !== "POST") {
      return null;
    }

    // Contract: clients must opt in to SSE explicitly.
    const acceptHeader = req.headers.get("accept") ?? "";
    if (!acceptHeader.includes("text/event-stream")) {
      return new Response(
        JSON.stringify({
          error: "Not Acceptable",
          message: "POST /agent requires `Accept: text/event-stream`.",
        }),
        { status: HTTP_STATUS.NOT_ACCEPTABLE, headers: JSON_HEADERS },
      );
    }

    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: "Invalid JSON body",
          message: err instanceof Error ? err.message : String(err),
        }),
        { status: HTTP_STATUS.BAD_REQUEST, headers: JSON_HEADERS },
      );
    }

    const validation = validateRunAgentInput(rawBody);
    if (!validation.valid) {
      return new Response(
        JSON.stringify({
          error: "Invalid RunAgentInput",
          issues: validation.error.issues,
        }),
        { status: HTTP_STATUS.BAD_REQUEST, headers: JSON_HEADERS },
      );
    }

    const input: RunAgentInput = validation.value;
    const promptText = extractLastUserText(input);
    if (promptText.length === 0) {
      return new Response(
        JSON.stringify({
          error: "No user message",
          message:
            "RunAgentInput.messages must contain at least one user-role message with text content.",
        }),
        { status: HTTP_STATUS.BAD_REQUEST, headers: JSON_HEADERS },
      );
    }
    const threadId = input.threadId ?? crypto.randomUUID();
    const runId = crypto.randomUUID();
    const correlationId = newCorrelationId();
    const audit = options.audit;
    const startedAtMs = Date.now();

    // Acquire the run slot BEFORE opening the SSE stream so a busy
    // response is a plain JSON 409 rather than an SSE error frame.
    // AG-UI is the primary browser run surface for restricted-beta;
    // overlapping runs against the shared primary controller would
    // ambiguously multiplex onto the same ACP session, so we reject
    // the second one with a clear signal.
    let lease: ReturnType<AguiRunCoordinator["acquire"]>;
    try {
      lease = coordinator.acquire(runId);
    } catch (err) {
      if (err instanceof AguiRunBusyError) {
        return new Response(
          JSON.stringify({
            error: "Busy",
            message: "another AG-UI run is active on this gateway; retry shortly",
            activeRunId: err.activeRunId,
          }),
          { status: HTTP_STATUS.CONFLICT, headers: JSON_HEADERS },
        );
      }
      throw err;
    }

    // Combine HTTP disconnect (req.signal) with a locally-owned abort source
    // so programmatic `reader.cancel()` on the stream also unwinds the
    // run-session without leaking the event subscription.
    const localAbort = new AbortController();
    const runSignal = req.signal
      ? AbortSignal.any([localAbort.signal, req.signal])
      : localAbort.signal;

    const stream = new ReadableStream<Uint8Array>({
      async start(streamController) {
        const emit = (event: Parameters<typeof enqueueAguiEvent>[1]) =>
          enqueueAguiEvent(streamController, event, logger);

        // RUN_STARTED must be the first frame on the wire.
        emit({
          type: EventType.RUN_STARTED,
          threadId,
          runId,
        });
        audit?.record({
          kind: "agui-run-started",
          correlationId,
          runId,
          threadId,
        });

        try {
          const result = await runAguiSession({
            controller: options.controller,
            threadId,
            runId,
            promptText,
            sink: streamController,
            abortSignal: runSignal,
            logger,
          });

          // `runAguiSession` emits the terminal event (RUN_FINISHED /
          // RUN_ERROR) via its own sink. If it returned without
          // emitting one — which happens on client disconnect before
          // `turn_completed` — emit a best-effort RUN_ERROR so the
          // contract stays intact for any still-connected observer.
          if (!result.finished && !result.errorMessage) {
            emit({
              type: EventType.RUN_ERROR,
              message: "run ended without terminal event",
            });
          }

          if (result.finished) {
            audit?.record({
              kind: "agui-run-finished",
              correlationId,
              runId,
              threadId,
              ...(result.stopReason ? { stopReason: result.stopReason } : {}),
              durationMs: Date.now() - startedAtMs,
            });
          } else if (result.errorMessage === "run canceled by disconnect") {
            audit?.record({
              kind: "agui-run-disconnect-cancel",
              correlationId,
              runId,
              threadId,
            });
          } else {
            audit?.record({
              kind: "agui-run-error",
              correlationId,
              runId,
              threadId,
              errorCategory: "run-session-non-terminal",
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error("[Gateway/AG-UI] Run session threw", { error: message });
          emit({ type: EventType.RUN_ERROR, message });
          audit?.record({
            kind: "agui-run-error",
            correlationId,
            runId,
            threadId,
            errorCategory: "run-session-threw",
          });
        } finally {
          lease.release();
          try {
            streamController.close();
          } catch {
            // already closed — ignore
          }
        }
      },
      cancel() {
        // Triggered either by HTTP disconnect (covered by req.signal) or
        // a programmatic reader.cancel() (which does NOT propagate to
        // req.signal). Aborting the local controller ensures the
        // run-session unwinds its subscription in both paths and that
        // the run-session calls controller.cancel() on the active
        // ACP turn (see agui-run-session.ts).
        localAbort.abort();
        // The lease is also released by the start() finally block;
        // calling release here too is safe (idempotent) and ensures
        // the slot is freed even if start() never observes the abort
        // (e.g. the SSE stream was canceled before start() ran).
        lease.release();
      },
    });

    return new Response(stream, {
      status: HTTP_STATUS.OK,
      headers: SSE_RESPONSE_HEADERS,
    });
  };
}

/**
 * Pull the last user-authored text from the input messages. Mirrors
 * how `HostA2AExecutor` treats A2A messages: the endpoint only needs the plain
 * user prompt for the ACP turn; multimodal content is not yet wired
 * through the AG-UI endpoint and will be a separate follow-up.
 */
function extractLastUserText(input: RunAgentInput): string {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string" && content.length > 0) {
      return content;
    }
  }
  return "";
}
