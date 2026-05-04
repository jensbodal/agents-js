/**
 * Hook invocation utility for session lifecycle hooks.
 *
 * Wraps async hook calls in error handling so that a misbehaving hook
 * never crashes the session controller.
 */
import type { Logger } from "./logger.ts";

/**
 * Safely invoke a session hook function.
 * If the hook throws, the error is logged and `undefined` is returned.
 */
export async function callHook<T>(
  log: Logger,
  hookName: string,
  fn: () => Promise<T> | T | undefined,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    log.warn(`Hook error in ${hookName}`, {
      hook: hookName,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
