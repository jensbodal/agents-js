/**
 * HTTP transport adapters for the gateway bus (AJS-8).
 *
 * Two handlers:
 *
 * - **SSE subscribe** (`GET /events` by default) — opens a long-lived
 *   `Content-Type: text/event-stream` response. Each bus event is
 *   serialized to `data: <JSON>\n\n` and written to the stream.
 *   Heartbeat comments (`: heartbeat\n\n`) keep the connection alive
 *   through intermediate proxies. Subscriber detaches when the client
 *   disconnects (signal aborts) or the gateway shuts down.
 *
 * - **Admin publish** (`POST /admin/publish` by default) — accepts a
 *   JSON body shaped like a partial `GatewayBusEvent` (`type` +
 *   `payload` required — use `null` for empty payload; the rest is
 *   populated server-side via `buildGatewayBusEvent`). Returns
 *   `200 OK` on success.
 *
 * ## v1 trust model
 *
 * Both handlers are trusted-network / internal-only per the AJS-8 v1
 * scope guards. No auth-z enforcement at the handler level — the
 * deployment is expected to bind the gateway to a local/loopback
 * interface and gate external reachability at the network layer.
 * Production deployments that need internet exposure must add their
 * own auth-z layer in front; that work is out of scope for v1.
 *
 * ## SSE framing
 *
 * Each frame:
 * ```
 * id: <event id>\n
 * data: <JSON-encoded GatewayBusEvent>\n
 * \n
 * ```
 *
 * Clients that reconnect with `Last-Event-ID` get *no replay* in v1 —
 * the bus is in-memory pub/sub, so events emitted between disconnect
 * and reconnect are lost. The `id` field is shipped anyway so future
 * durable-storage support can layer replay on without re-cutting the
 * wire.
 */

import { HTTP_STATUS } from "@agents-js/a2a";
import {
  buildGatewayBusEvent,
  type GatewayBus,
  type GatewayBusEvent,
  type IdentityPrincipal,
} from "./gateway-bus.ts";

const SSE_RESPONSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

const JSON_HEADERS = { "Content-Type": "application/json" };
const SSE_ENCODER = new TextEncoder();
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_SUBSCRIBE_PATH = "/events";
const DEFAULT_PUBLISH_PATH = "/admin/publish";

/** Common construction options. */
export interface BusEndpointOptions {
  bus: GatewayBus;
  logger?: Pick<Console, "warn" | "error" | "log">;
}

/** SSE subscribe handler options. */
export interface CreateBusSubscribeHandlerOptions extends BusEndpointOptions {
  /** Request path. Defaults to `/events`. */
  path?: string;
  /**
   * Heartbeat interval in milliseconds. Sends a `: heartbeat\n\n` SSE
   * comment line at this cadence to keep intermediate proxies from
   * closing idle connections. Defaults to 30000 (30s). Set to `0` to
   * disable heartbeats (only sensible in tests).
   */
  heartbeatMs?: number;
}

/** Admin publish handler options. */
export interface CreateBusPublishHandlerOptions extends BusEndpointOptions {
  /** Request path. Defaults to `/admin/publish`. */
  path?: string;
}

/**
 * Body shape accepted by the admin publish endpoint. Payload is
 * required — the bus envelope's `payload` field is non-optional, so
 * publishers must supply something (use `null` for "no payload"
 * intent rather than omitting).
 */
interface PublishRequestBody {
  type: string;
  payload: unknown;
  sourcePrincipal?: IdentityPrincipal;
  correlationId?: string;
}

/** Serialize a bus event to an SSE frame including the `id` field. */
function formatBusSseFrame(event: GatewayBusEvent<unknown>): Uint8Array {
  return SSE_ENCODER.encode(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** Serialize a heartbeat comment frame. SSE-spec comment lines start with `:`. */
function formatHeartbeatFrame(): Uint8Array {
  return SSE_ENCODER.encode(`: heartbeat\n\n`);
}

/**
 * Build a `GET /events` SSE handler that streams every bus event to
 * subscribed clients. Returns `null` for non-matching paths so the
 * caller can fall through to the next handler.
 */
export function createBusSubscribeHandler(
  options: CreateBusSubscribeHandlerOptions,
): (req: Request) => Promise<Response | null> {
  const path = options.path ?? DEFAULT_SUBSCRIBE_PATH;
  const logger = options.logger ?? console;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const { bus } = options;

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== path) return null;
    if (req.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: HTTP_STATUS.METHOD_NOT_ALLOWED,
        headers: { Allow: "GET" },
      });
    }

    let unsubscribe: (() => void) | undefined;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Attach to the bus. Each event becomes one SSE frame.
        unsubscribe = bus.subscribe((event) => {
          try {
            controller.enqueue(formatBusSseFrame(event));
          } catch (err) {
            // Most likely the controller has already been closed by an
            // abort that hasn't reached the cleanup path yet. Drop the
            // event silently — the client is going away.
            logger.warn("[gateway-bus/sse] enqueue failed", {
              error: err instanceof Error ? err.message : String(err),
              eventId: event.id,
            });
          }
        });

        if (heartbeatMs > 0) {
          heartbeatTimer = setInterval(() => {
            try {
              controller.enqueue(formatHeartbeatFrame());
            } catch {
              // Same rationale as above — controller closed mid-flight.
            }
          }, heartbeatMs);
        }
      },
      cancel() {
        if (unsubscribe) unsubscribe();
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      },
    });

    // If the client aborts (browser navigated away, fetch aborted),
    // tear down the subscription + heartbeat. The cancel() above also
    // covers this path, but listening explicitly to the signal makes
    // the lifecycle obvious. `{ once: true }` removes the listener
    // after a single firing so we don't retain closures for the
    // lifetime of the SSE connection.
    req.signal.addEventListener(
      "abort",
      () => {
        if (unsubscribe) unsubscribe();
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      },
      { once: true },
    );

    return new Response(stream, {
      status: HTTP_STATUS.OK,
      headers: SSE_RESPONSE_HEADERS,
    });
  };
}

/**
 * Build a `POST /admin/publish` handler that injects events onto the
 * bus from operator tooling. Returns `null` for non-matching paths.
 *
 * Body shape (generic — Matrix, Slack, GitHub bridges all share this):
 * ```json
 * {
 *   "type": "gateway.<source>.<verb>",
 *   "payload": { ... },
 *   "sourcePrincipal": { "kind": "<source>", "id": "<author>" },
 *   "correlationId": "abc-123"
 * }
 * ```
 *
 * The handler validates `type` is a non-empty, non-whitespace string,
 * and that `payload` is present (use `null` for empty intent). `payload`
 * is accepted as any JSON value. Server-side fields (`id`, `ts`) are
 * populated via `buildGatewayBusEvent`.
 *
 * Returns 200 because the publish completes synchronously in v1
 * (in-memory pub/sub, no queue between publish and fan-out). The body's
 * `accepted: true` field carries the publish-receipt semantic without
 * needing a 202 — and the monorepo's HTTP_STATUS constants
 * intentionally don't pre-populate codes we don't emit.
 */
export function createBusPublishHandler(
  options: CreateBusPublishHandlerOptions,
): (req: Request) => Promise<Response | null> {
  const path = options.path ?? DEFAULT_PUBLISH_PATH;
  const logger = options.logger ?? console;
  const { bus } = options;

  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== path) return null;
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ error: "method not allowed" }), {
        status: HTTP_STATUS.METHOD_NOT_ALLOWED,
        headers: { ...JSON_HEADERS, Allow: "POST" },
      });
    }

    let body: PublishRequestBody;
    try {
      body = (await req.json()) as PublishRequestBody;
    } catch (err) {
      logger.warn("[gateway-bus/publish] invalid JSON body", {
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(JSON.stringify({ error: "invalid JSON body" }), {
        status: HTTP_STATUS.BAD_REQUEST,
        headers: JSON_HEADERS,
      });
    }

    if (!body || typeof body.type !== "string" || body.type.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "request body must include a non-empty `type` field" }),
        { status: HTTP_STATUS.BAD_REQUEST, headers: JSON_HEADERS },
      );
    }

    if (!("payload" in body)) {
      return new Response(
        JSON.stringify({
          error: "request body must include a `payload` field (use `null` for empty)",
        }),
        { status: HTTP_STATUS.BAD_REQUEST, headers: JSON_HEADERS },
      );
    }

    const event = buildGatewayBusEvent({
      type: body.type.trim(),
      payload: body.payload,
      sourcePrincipal: body.sourcePrincipal,
      correlationId: body.correlationId,
    });

    bus.publish(event);

    return new Response(JSON.stringify({ id: event.id, accepted: true }), {
      status: HTTP_STATUS.OK,
      headers: JSON_HEADERS,
    });
  };
}
