import { createParseEnv, runCommand } from "@agents-js/gateway-runtime";
import type { Logger } from "../logger.ts";

const MATRIX_SEND_TIMEOUT_MS = 10_000;

type Notifier = (message: string) => Promise<boolean>;
type RunCommand = typeof runCommand;

interface MatrixNotifierDependencies {
  runCommand?: RunCommand;
  whichBun?: () => string | undefined;
}

interface ResolvedMatrixConfig {
  matrixClient: string;
  matrixAgent: string;
  matrixRoom: string;
  bunBinary: string;
}

/**
 * Matrix transport. Builds a `matrix-client send` subprocess invocation
 * from env vars and exposes it as a {@link Notifier}.
 *
 * Env vars use the legacy `PLANE_WEBHOOK_*` prefix for operational
 * compatibility with existing Plane webhook deployments:
 *
 * - `PLANE_WEBHOOK_NOTIFY_ENABLED` — gate; truthy values per `parseEnv` (`true`/`1`/`yes`/`on`)
 * - `PLANE_WEBHOOK_BUN` — bun binary path (default: `Bun.which("bun")`)
 * - `PLANE_WEBHOOK_MATRIX_CLIENT` — required when enabled; path to `matrix-client.ts`
 * - `PLANE_WEBHOOK_MATRIX_AGENT` — required when enabled; Matrix identity to send as
 * - `PLANE_WEBHOOK_MATRIX_ROOM` — required when enabled; Matrix room to post into
 *
 * No deployment-specific defaults — operator must supply identity/room/client
 * explicitly so this transport stays portable across deployments.
 *
 * Env is fully resolved (and required-field checked) at factory time; the
 * returned notifier reuses the validated config on every call.
 */
export default function createMatrixNotifierFromEnv(
  logger: Logger,
  env: NodeJS.ProcessEnv,
  dependencies: MatrixNotifierDependencies = {},
): Notifier {
  const parseEnv = createParseEnv(env);
  const enabled = parseEnv("PLANE_WEBHOOK_NOTIFY_ENABLED").optional().boolean() ?? false;

  if (!enabled) {
    return async () => {
      logger.log("[Transports/Matrix] notification disabled by env");
      return false;
    };
  }

  const config = resolveMatrixConfig(env, dependencies.whichBun);
  if (!config) {
    const missing = collectMissingEnv(env);
    throw new Error(
      `Matrix notification is enabled but required env is missing: ${missing.join(", ")}`,
    );
  }

  return async (message: string): Promise<boolean> => {
    await (dependencies.runCommand ?? runCommand)(config.bunBinary, buildArgv(config, message), {
      onError: "throw",
      timeoutMs: MATRIX_SEND_TIMEOUT_MS,
    });
    return true;
  };
}

function resolveMatrixConfig(
  env: NodeJS.ProcessEnv,
  whichBun: (() => string | undefined) | undefined,
): ResolvedMatrixConfig | null {
  const matrixClient = env.PLANE_WEBHOOK_MATRIX_CLIENT?.trim();
  const matrixAgent = env.PLANE_WEBHOOK_MATRIX_AGENT?.trim();
  const matrixRoom = env.PLANE_WEBHOOK_MATRIX_ROOM?.trim();
  if (!matrixClient || !matrixAgent || !matrixRoom) return null;
  const bunBinary = env.PLANE_WEBHOOK_BUN?.trim() || whichBun?.() || Bun.which("bun") || "bun";
  return { matrixClient, matrixAgent, matrixRoom, bunBinary };
}

function buildArgv(config: ResolvedMatrixConfig, message: string): string[] {
  return [
    config.matrixClient,
    "send",
    "--as",
    config.matrixAgent,
    "--room",
    config.matrixRoom,
    "--plain",
    message,
  ];
}

function collectMissingEnv(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (!env.PLANE_WEBHOOK_MATRIX_CLIENT?.trim()) missing.push("PLANE_WEBHOOK_MATRIX_CLIENT");
  if (!env.PLANE_WEBHOOK_MATRIX_AGENT?.trim()) missing.push("PLANE_WEBHOOK_MATRIX_AGENT");
  if (!env.PLANE_WEBHOOK_MATRIX_ROOM?.trim()) missing.push("PLANE_WEBHOOK_MATRIX_ROOM");
  return missing;
}
