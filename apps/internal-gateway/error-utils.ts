/**
 * Best-effort error description for gateway-side logging. Handles `Error`
 * instances, string literals, JSON-RPC-style `{ message, data }` payloads,
 * and falls back to `JSON.stringify` / `String(error)` for opaque values.
 */
export function describeGatewayError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  if (error && typeof error === "object") {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
    const data = Reflect.get(error, "data");
    if (typeof data === "string" && data.length > 0) {
      return data;
    }
    if (data && typeof data === "object") {
      const details = Reflect.get(data, "details");
      if (typeof details === "string" && details.length > 0) {
        return details;
      }
      try {
        return JSON.stringify(data);
      } catch {
        return String(data);
      }
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return "Unknown error";
}
