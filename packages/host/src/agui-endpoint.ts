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

    const rawTextContract = inspectRawLastUserContent(rawBody);
    if (rawTextContract === "non-text") {
      return new Response(
        JSON.stringify({
          error: "Unsupported user message content",
          message: "POST /agent accepts text user messages only.",
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
    const userText = extractLastUserText(input);
    if (!userText.ok) {
      return new Response(
        JSON.stringify({
          error: userText.error,
          message: userText.message,
        }),
        { status: HTTP_STATUS.BAD_REQUEST, headers: JSON_HEADERS },
      );
    }
    const promptText = userText.text;
    // Honor the AG-UI client-supplied identity. `RunAgentInputSchema`
    // requires both fields to be non-empty strings (validated above by
    // `validateRunAgentInput`), so a missing or blank value here is
    // already a 400; the fallbacks protect callers if the schema
    // contract is relaxed.
    const threadId =
      typeof input.threadId === "string" && input.threadId.length > 0
        ? input.threadId
        : crypto.randomUUID();
    const runId =
      typeof input.runId === "string" && input.runId.length > 0 ? input.runId : crypto.randomUUID();
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
            // Error frames carry threadId/runId so clients can
            // correlate the failure with its run. The upstream zod
            // schema is `.passthrough()` so adding them is permitted.
            emit({
              type: EventType.RUN_ERROR,
              message: "run ended without terminal event",
              threadId,
              runId,
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
          emit({ type: EventType.RUN_ERROR, message, threadId, runId });
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
        // run-session unwinds its subscription in both paths and the
        // run-session awaits `controller.cancel()` before resolving
        // its `done` promise.
        //
        // **The lease is intentionally NOT released here.** Releasing
        // on cancel() would free the run slot before
        // `runAguiSession` finished awaiting the controller cancel —
        // the next `POST /agent` could 200 against a controller still
        // draining the cancelled turn. The single release point is
        // the start() `finally` block below, which only runs after
        // the run-session has actually unwound.
        localAbort.abort();
      },
    });

    return new Response(stream, {
      status: HTTP_STATUS.OK,
      headers: SSE_RESPONSE_HEADERS,
    });
  };
}

function inspectRawLastUserContent(input: unknown): "text" | "non-text" | "absent" {
  if (typeof input !== "object" || input === null) return "absent";
  const messages = (input as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return "absent";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    return typeof message.content === "string" ? "text" : "non-text";
  }
  return "absent";
}

/**
 * Pull the last user-authored text from the input messages. The current
 * `/agent` contract is text-only, so non-string user content fails closed
 * with a 400 instead of being silently ignored.
 */
function extractLastUserText(
  input: RunAgentInput,
): { ok: true; text: string } | { ok: false; error: string; message: string } {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string" && content.length > 0) {
      return { ok: true, text: content };
    }
    if (typeof content !== "string") {
      return {
        ok: false,
        error: "Unsupported user message content",
        message: "POST /agent accepts text user messages only.",
      };
    }
  }
  return {
    ok: false,
    error: "No user message",
    message:
      "RunAgentInput.messages must contain at least one user-role message with text content.",
  };
}
