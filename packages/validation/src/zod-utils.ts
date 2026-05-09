import { z } from "zod";
import type { ValidationIssue } from "./errors.ts";
import type { ValidationMode } from "./modes.ts";

/**
 * Minimum duck-typed shape of a Zod `ZodError` that we actually read.
 * Works for both Zod v3 (used by `@ag-ui/core` and `@a2ui/web_core`)
 * and Zod v4 (used by this package), whose public `.issues[]` shape is
 * runtime-identical even though the types are incompatible.
 */
interface ZodErrorLike {
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    message: string;
    code?: string;
  }>;
}

/**
 * Zod-version-agnostic conversion of a `ZodError` to the canonical
 * {@link ValidationIssue} shape. Accepts errors from either Zod v3 or v4
 * without triggering structural-type incompatibility, because we only
 * rely on the public, stable `.issues[]` runtime shape.
 */
export function zodIssuesToValidationIssues(error: ZodErrorLike): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "input",
    message: issue.message,
    keyword: issue.code,
  }));
}

/**
 * @deprecated Use {@link zodIssuesToValidationIssues} — it accepts both
 * Zod v3 and v4 errors via duck-typing. Kept as an alias for callers that
 * want the v4-typed signature.
 */
export function toValidationIssues(error: z.ZodError): ValidationIssue[] {
  return zodIssuesToValidationIssues(error);
}

export function zodObjectWithMode<T extends z.ZodRawShape>(shape: T, mode: ValidationMode) {
  const objectSchema = z.object(shape);

  if (mode === "loose") {
    return objectSchema.passthrough();
  }

  if (mode === "filter") {
    return objectSchema.strip();
  }

  return objectSchema.strict();
}
