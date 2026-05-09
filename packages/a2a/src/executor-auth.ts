type ACPErrorShape = {
  code?: number;
  data?: Record<string, unknown>;
  message?: string;
};

export function isACPAuthRequiredError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as ACPErrorShape;
  if (candidate.code === -32001 && candidate.data?.reason === "auth_required") {
    return true;
  }

  return candidate.message === "auth_required";
}

/**
 * Retry an async operation when it fails with an ACP auth_required error.
 *
 * @param fn - The operation to attempt
 * @param handleAuth - Called on auth errors; returns true if auth was handled and retry should proceed
 * @param maxRetries - Maximum number of auth retries before giving up
 */
export async function withAuthRetry<T>(
  fn: () => Promise<T>,
  handleAuth: (error: unknown) => Promise<boolean>,
  maxRetries: number,
): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!(await handleAuth(error))) {
        throw error;
      }
      if (++retries >= maxRetries) {
        throw new Error(`ACP authentication failed after ${maxRetries} attempts`);
      }
    }
  }
}
