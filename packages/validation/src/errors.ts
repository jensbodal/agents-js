export interface ValidationIssue {
  path: string;
  message: string;
  keyword?: string;
}

interface AjvErrorLike {
  instancePath?: string;
  message?: string;
  keyword?: string;
  params?: unknown;
}

function normalizeAjvPath(error: AjvErrorLike, fallbackField?: string): string {
  const rawPath = error.instancePath ?? "";
  const normalizedPath = rawPath.startsWith("/") ? rawPath.slice(1).replaceAll("/", ".") : rawPath;

  if (error.keyword === "additionalProperties" || error.keyword === "unevaluatedProperties") {
    const propertyKey =
      error.keyword === "additionalProperties" ? "additionalProperty" : "unevaluatedProperty";
    const additionalProperty =
      typeof error.params === "object" &&
      error.params !== null &&
      propertyKey in error.params &&
      typeof (error.params as Record<string, unknown>)[propertyKey] === "string"
        ? ((error.params as Record<string, unknown>)[propertyKey] as string)
        : undefined;

    if (additionalProperty) {
      return normalizedPath ? `${normalizedPath}.${additionalProperty}` : additionalProperty;
    }
  }

  return normalizedPath || fallbackField || "input";
}

function normalizeAjvMessage(error: AjvErrorLike): string {
  if (error.keyword === "additionalProperties" || error.keyword === "unevaluatedProperties") {
    return "Unknown property";
  }

  return error.message ?? "Invalid value";
}

export interface ValidationErrorOptions {
  field?: string;
  value?: unknown;
  issues?: ValidationIssue[];
  jsonRpcCode?: -32600 | -32602;
}

/** Structured validation error with context about what failed */
export class ValidationError extends Error {
  public readonly field: string;
  public readonly value: unknown;
  public readonly issues: ValidationIssue[];
  public readonly jsonRpcCode?: -32600 | -32602;

  constructor(message: string, field: string, value: unknown);
  constructor(message: string, options?: ValidationErrorOptions);
  constructor(
    message: string,
    fieldOrOptions: string | ValidationErrorOptions = "input",
    legacyValue?: unknown,
  ) {
    const options: ValidationErrorOptions =
      typeof fieldOrOptions === "string"
        ? { field: fieldOrOptions, value: legacyValue }
        : fieldOrOptions;

    const normalizedField = options.field ?? options.issues?.[0]?.path ?? "input";
    super(`Validation failed for "${normalizedField}": ${message}`);

    this.name = "ValidationError";
    this.field = normalizedField;
    this.value = options.value;
    this.issues = options.issues ?? [];
    this.jsonRpcCode = options.jsonRpcCode;
  }

  public static fromAjvErrors(
    errors: ReadonlyArray<AjvErrorLike> | null | undefined,
    message: string,
    options: Omit<ValidationErrorOptions, "issues"> = {},
  ): ValidationError {
    const issues: ValidationIssue[] = (errors ?? []).map((error) => {
      return {
        path: normalizeAjvPath(error, options.field),
        message: normalizeAjvMessage(error),
        keyword: error.keyword,
      };
    });

    return new ValidationError(message, {
      ...options,
      field: options.field ?? issues[0]?.path,
      issues,
    });
  }
}
