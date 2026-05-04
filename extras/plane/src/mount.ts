import { resolvePlaneWebhookSecretFromEnv } from "./env.ts";
import type { Logger } from "./logger.ts";
import createMatrixNotifierFromEnv from "./transport/matrix.ts";
import {
  type PlaneWebhookFetchHandlerOptions as CorePlaneWebhookFetchHandlerOptions,
  createPlaneWebhookFetchHandler as createCorePlaneWebhookFetchHandler,
  verifyPlaneSignature,
} from "./webhook.ts";

// Re-exported so consumers of `@agents-js/plane/mount` don't also need to
// reach into `webhook.ts` for the manual signature-verification helper used
// by tests.
export { verifyPlaneSignature };

export interface PlaneWebhookFetchHandlerOptions extends CorePlaneWebhookFetchHandlerOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Env-driven Plane webhook mount used by the CLI's `serve` command and
 * `apps/internal-gateway`. Wires the core webhook handler with:
 *
 * - secret resolution via {@link resolvePlaneWebhookSecretFromEnv} (env, then gopass)
 * - Matrix notification via {@link createMatrixNotifierFromEnv}
 *
 * Pass `env` explicitly from a test harness; defaults to `Bun.env` in production.
 */
export function createPlaneWebhookFetchHandler(
  options: PlaneWebhookFetchHandlerOptions = {},
): (req: Request) => Promise<Response | null> {
  const { env = Bun.env, notifyMatrix, secret, secretResolver, ...runtimeOptions } = options;
  const logger: Logger = options.logger ?? console;

  return createCorePlaneWebhookFetchHandler({
    ...runtimeOptions,
    secret,
    secretResolver:
      secretResolver ?? (async () => secret ?? (await resolvePlaneWebhookSecretFromEnv(env))),
    notifyMatrix: notifyMatrix ?? createMatrixNotifierFromEnv(logger, env),
  });
}
