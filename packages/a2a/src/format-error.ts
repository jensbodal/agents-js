/**
 * Extract a human-readable message from an unknown error value.
 * Works with Error instances, plain objects with a `message` property, and raw strings.
 */
export function formatErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}
