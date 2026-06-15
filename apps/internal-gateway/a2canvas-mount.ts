/**
 * A2Canvas `/events` mount — the transport adapter over an
 * {@link A2CanvasBoardHost}. Streams the laned, newest-first board view to
 * subscribed clients (the iPhone/browser viewer) as Server-Sent Events.
 *
 * This is the renderer-facing seam's serving half: producers (a2canvas-
 * producers: mappers + poller) call `boardHost.ingest()`; the board-host owns
 * merge/order; this handler only *reads* `boardHost.view()` and pushes
 * snapshots. The board object itself never crosses the wire — only the derived
 * `A2CanvasView`.
 *
 * Self-routes on `GET /a2canvas/events` and returns `null` for everything else
 * so it composes cleanly through the gateway's `composeAdditionalFetch` chain,
 * exactly like the bus `/events` handler it mirrors.
 */
import type { A2CanvasBoardHost, A2CanvasView } from "@agents-js/a2canvas";

const SSE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const SSE_ENCODER = new TextEncoder();
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_EVENTS_PATH = "/a2canvas/events";

export interface CreateA2CanvasEventsHandlerOptions {
  /** Request path. Defaults to `/a2canvas/events`. */
  path?: string;
  /**
   * Heartbeat interval (ms). Sends a `: heartbeat` SSE comment to keep idle
   * proxies from closing the connection. Defaults to 30000; `0` disables it
   * (only sensible in tests).
   */
  heartbeatMs?: number;
  logger?: Pick<Console, "warn">;
}

/** Serialize a board view to an SSE frame; `seq` is the resumable event id. */
function formatViewFrame(view: A2CanvasView): Uint8Array {
  return SSE_ENCODER.encode(`id: ${view.seq}\ndata: ${JSON.stringify(view)}\n\n`);
}

function formatHeartbeatFrame(): Uint8Array {
  return SSE_ENCODER.encode(`: heartbeat\n\n`);
}

/**
 * Build a `GET /a2canvas/events` SSE handler that emits the current board view
 * immediately, then a fresh view on every board change. Returns `null` for
 * non-matching paths so the caller can fall through to the next handler.
 */
export function createA2CanvasEventsHandler(
  boardHost: A2CanvasBoardHost,
  options: CreateA2CanvasEventsHandlerOptions = {},
): (req: Request) => Promise<Response | null> {
  const path = options.path ?? DEFAULT_EVENTS_PATH;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const logger = options.logger ?? console;

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== path) return null;
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (view: A2CanvasView): void => {
          try {
            controller.enqueue(formatViewFrame(view));
          } catch {
            // Controller already closed by the client mid-flight — drop.
            logger.warn("[gateway-a2canvas/sse] enqueue failed (client closed)");
          }
        };
        // Initial snapshot so a fresh viewer renders the full board at once.
        push(boardHost.view());
        unsubscribe = boardHost.subscribe(push);
        if (heartbeatMs > 0) {
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(formatHeartbeatFrame());
            } catch {
              logger.warn("[gateway-a2canvas/sse] heartbeat enqueue failed (client closed)");
            }
          }, heartbeatMs);
        }
      },
      cancel() {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
      },
    });

    return new Response(stream, { status: 200, headers: SSE_RESPONSE_HEADERS });
  };
}
