/**
 * Error thrown by the A2UI renderer when it cannot map an A2UI component onto
 * a concrete host primitive (unknown catalog id, unknown component name, or
 * property-binding failure).
 */
export class A2uiRendererError extends Error {
  /** The catalog id that was being rendered when the error occurred, if known. */
  readonly catalogId?: string;
  /** The component name (per A2UI `ComponentApi.name`) that failed, if known. */
  readonly componentName?: string;

  constructor(
    message: string,
    options?: { catalogId?: string; componentName?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "A2uiRendererError";
    this.catalogId = options?.catalogId;
    this.componentName = options?.componentName;
  }
}
