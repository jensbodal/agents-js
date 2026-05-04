import { runCommand } from "@agents-js/gateway-runtime";

const DEFAULT_GOPASS_SECRET_PATH = "services/plane/webhook_secret";
const GOPASS_TIMEOUT_MS = 5_000;

/**
 * Resolve the Plane webhook HMAC secret from operator-provided env.
 *
 * Resolution order:
 * 1. `PLANE_WEBHOOK_SECRET` — direct value (preferred for tests / explicit ops)
 * 2. `gopass show -o <PLANE_WEBHOOK_SECRET_GOPASS_PATH | services/plane/webhook_secret>`
 *
 * Returns `null` when neither path yields a value (including timeout — gopass
 * can hang on an interactive unlock prompt).
 */
export async function resolvePlaneWebhookSecretFromEnv(
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const direct = env.PLANE_WEBHOOK_SECRET?.trim();
  if (direct) return direct;

  const gopassPath = env.PLANE_WEBHOOK_SECRET_GOPASS_PATH?.trim() ?? DEFAULT_GOPASS_SECRET_PATH;
  try {
    const { stdout, exitCode, timedOut } = await runCommand("gopass", ["show", "-o", gopassPath], {
      timeoutMs: GOPASS_TIMEOUT_MS,
    });
    if (timedOut || exitCode !== 0) return null;
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
