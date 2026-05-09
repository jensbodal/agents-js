/**
 * Error-formatting helpers that preserve JSON-RPC `data` context from ACP
 * {@link RequestError} instances thrown by `@agentclientprotocol/sdk`.
 *
 * The SDK's `RequestError` has this shape:
 *
 * ```ts
 * class RequestError extends Error {
 *   code: number;
 *   data?: unknown;
 * }
 * ```
 *
 * When an ACP runtime returns a JSON-RPC error (e.g. opencode returning
 * `{ code: -32603, message: "Internal error", data: { details: "default agent \"X\" not found" } }`),
 * the SDK throws a `RequestError` with `message = "Internal error"` and
 * `data = { details: "..." }`. Raw `err.message` extraction loses the
 * actionable detail and reduces downstream task-failed bodies to the
 * uninformative "Internal error" string.
 *
 * These helpers preserve that context without hard-coupling agents-js to
 * the SDK's concrete `RequestError` class (duck-typed on `{ code, data }`),
 * so we remain resilient to SDK minor-version shape drift.
 */

/**
 * Shape we duck-type against — covers SDK `RequestError` and any other
 * Error subclass that attaches JSON-RPC `code` + `data` fields.
 */
interface JsonRpcErrorShape {
  code?: unknown;
  data?: unknown;
}

/**
 * Extract the most useful human-readable string from a JSON-RPC error's
 * `data` field. Priority:
 *   1. `data.details` (string)
 *   2. `data.message` (string)
 *   3. JSON-stringified `data` (non-empty, non-`{}` object)
 * Returns `undefined` if nothing useful is present.
 */
export function extractRequestErrorDetails(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as JsonRpcErrorShape).data;
  if (!data) return undefined;

  if (typeof data === "string" && data.trim().length > 0) {
    return data;
  }

  if (typeof data === "object") {
    const asRecord = data as Record<string, unknown>;
    const details = asRecord.details;
    if (typeof details === "string" && details.trim().length > 0) {
      return details;
    }
    const msg = asRecord.message;
    if (typeof msg === "string" && msg.trim().length > 0) {
      return msg;
    }
    try {
      const stringified = JSON.stringify(data);
      if (stringified && stringified !== "{}" && stringified !== "null") {
        return stringified;
      }
    } catch {
      // Cyclic or non-serializable — fall through.
    }
  }

  return undefined;
}

/**
 * Format an error into a single human-readable string that includes both
 * `error.message` AND any `data.details` / `data.message` context from a
 * JSON-RPC `RequestError`. Falls back to `error.message` (or `String(error)`
 * for non-Error throws) when no extra context is present.
 *
 * Examples:
 *   formatRequestError(new RequestError(-32603, "Internal error", { details: "agent X not found" }))
 *     → `Internal error: agent X not found`
 *   formatRequestError(new Error("plain"))  → `plain`
 *   formatRequestError("oops")              → `oops`
 */
export function formatRequestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const details = extractRequestErrorDetails(error);
  if (!details || details === error.message) {
    return error.message;
  }
  return `${error.message}: ${details}`;
}
