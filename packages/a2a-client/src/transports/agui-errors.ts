/**
 * Thrown by {@link AguiToA2ATransportAdapter} when a caller invokes an
 * A2A task-shaped method that has no AG-UI counterpart (e.g. `getTask`,
 * `cancelTask`, push-notification config).
 *
 * AG-UI has no task lifecycle; the adapter synthesizes a minimal `Task`
 * from `RUN_STARTED`/`RUN_FINISHED`/`RUN_ERROR` but cannot answer
 * out-of-band task queries.
 */
export class AGUIUnsupportedOperationError extends Error {
  readonly operation: string;

  constructor(operation: string, message?: string) {
    super(message ?? `[a2a-client] AG-UI transport does not support operation: ${operation}`);
    this.name = "AGUIUnsupportedOperationError";
    this.operation = operation;
  }
}

/**
 * Thrown by {@link parseAguiSseStream} / {@link AGUITransport} when the
 * server-sent event stream is malformed, emits an invalid AG-UI event,
 * or is torn down unexpectedly.
 */
export class AGUIStreamError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AGUIStreamError";
    this.cause = cause;
  }
}
