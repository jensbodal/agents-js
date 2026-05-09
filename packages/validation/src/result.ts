import type { ValidationError } from "./errors.ts";

/**
 * Result of a non-throwing validation call. Mirrors the Zod `safeParse`
 * shape but exposes a structured {@link ValidationError} on failure so
 * consumers get the same error surface across every validator in this
 * package (AG-UI, A2UI, ACP, A2A, JSON-RPC, runtime manifests).
 */
export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; error: ValidationError };
