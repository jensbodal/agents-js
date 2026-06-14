/**
 * SSE bus subscriber for the MCP bridge.
 *
 * Opens a long-lived HTTP GET to the gateway's `/events` endpoint,
 * parses each `data: ` line as a JSON-serialized {@link GatewayBusEvent},
 * and invokes the supplied handler. Reconnects with exponential
 * backoff on disconnect; honors {@link AbortController}-based
 * shutdown.
 *
 * The subscriber does NO filtering or transformation — it just
 * decodes the SSE stream and hands each parsed event to the caller.
 * Filtering happens at the event-mapper layer.
 */

import type { GatewayBusEvent } from "@agents-js/host";

/** Minimal logger contract — `console` satisfies this. */
export interface BusSubscriberLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Options for {@link runBusSubscriber}. */
export interface RunBusSubscriberOptions {
  /** Full URL of the SSE endpoint (e.g. `http://localhost:8080/events`). */
  url: string;
  /** Invoked once per decoded bus event. May be async. */
  onEvent(event: GatewayBusEvent<unknown>): void | Promise<void>;
  /** AbortSignal that ends the subscription when triggered. */
  signal: AbortSignal;
  /** Initial reconnect delay (ms) after a disconnect. */
  reconnectMinMs: number;
  /** Maximum reconnect delay (ms). Backoff doubles until this cap. */
  reconnectMaxMs: number;
  /** Optional logger. Defaults to `console`. */
  logger?: BusSubscriberLogger;
  /**
   * Optional fetch override (for tests). Defaults to global `fetch`.
   * Must produce a response with an SSE `body` stream.
   */
  fetchImpl?: typeof fetch;
  /** Optional sleep override (for tests / fake clocks). */
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Run the SSE subscriber loop until `signal` aborts. Returns when the
 * signal aborts; never throws on transport errors (they trigger
 * reconnect instead).
 */
export async function runBusSubscriber(options: RunBusSubscriberOptions): Promise<void> {
  const logger = options.logger ?? console;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleepWithAbort;

  let backoffMs = options.reconnectMinMs;

  while (!options.signal.aborted) {
    let attemptFailed = false;
    try {
      const response = await fetchImpl(options.url, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
        signal: options.signal,
      });

      if (!response.ok || !response.body) {
        logger.warn("[mcp-bus-bridge] gateway SSE returned non-OK", {
          status: response.status,
        });
        attemptFailed = true;
      } else {
        // Connection established — reset backoff so a subsequent
        // failure-sleep starts at min instead of the previous run's
        // doubled value.
        backoffMs = options.reconnectMinMs;
        await consumeSseStream(response.body, options.onEvent, logger, options.signal);
      }
    } catch (err) {
      if (options.signal.aborted) return;
      logger.warn("[mcp-bus-bridge] gateway SSE error", {
        error: err instanceof Error ? err.message : String(err),
      });
      attemptFailed = true;
    }

    if (options.signal.aborted) return;
    await sleepImpl(backoffMs, options.signal);
    // Only grow the backoff after a failed attempt. A successful
    // connection that ended normally re-enters the loop at the
    // current (min) backoff value.
    if (attemptFailed) {
      backoffMs = Math.min(backoffMs * 2, options.reconnectMaxMs);
    }
  }
}

/**
 * Read an SSE response body to completion, invoking `onEvent` for
 * each decoded `data:` line that parses as a {@link GatewayBusEvent}.
 * Returns when the stream ends or `signal` aborts.
 */
async function consumeSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: GatewayBusEvent<unknown>) => void | Promise<void>,
  logger: BusSubscriberLogger,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // If the caller's signal aborts while we're blocked on
  // reader.read() with no incoming data, the read promise will never
  // settle on its own. Wire an explicit abort listener that cancels
  // the reader, which causes the pending read to reject and the loop
  // to exit. `{ once: true }` so we don't retain a closure past the
  // stream's lifetime.
  const onAbort = (): void => {
    reader.cancel().catch(() => {
      // best-effort
    });
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!signal.aborted) {
      let value: Uint8Array | undefined;
      let done = false;
      try {
        const next = await reader.read();
        value = next.value;
        done = next.done;
      } catch {
        // reader.cancel() (from the abort listener) makes read()
        // reject. Treat as a normal end-of-stream.
        return;
      }
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by blank lines (\n\n).
      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        await dispatchFrame(frame, onEvent, logger);
        frameEnd = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
  }
}

async function dispatchFrame(
  frame: string,
  onEvent: (event: GatewayBusEvent<unknown>) => void | Promise<void>,
  logger: BusSubscriberLogger,
): Promise<void> {
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const json = line.slice("data:".length).trimStart();
    if (json.length === 0) continue;
    try {
      const parsed = JSON.parse(json) as GatewayBusEvent<unknown>;
      await onEvent(parsed);
    } catch (err) {
      logger.warn("[mcp-bus-bridge] failed to parse SSE frame", {
        error: err instanceof Error ? err.message : String(err),
        frame,
      });
    }
  }
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
