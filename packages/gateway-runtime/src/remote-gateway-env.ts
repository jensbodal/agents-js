/**
 * remote-gateway-env.ts — Hostname-mode + coordinator-URL env contract
 *
 * Implements the federated-gateway environment surface (AJS-23 v1 spec).
 * A gateway either advertises a resolvable hostname directly (the default,
 * back-compatible behavior) or runs in "null" hostname mode, in which case
 * it must publish itself through a coordinator's agent-registry endpoint.
 *
 * Env vars:
 *   AJS_GATEWAY_HOSTNAME_MODE   "resolvable" (default) | "null"
 *   AJS_GATEWAY_COORDINATOR_URL <url>  required when mode === "null";
 *                                       must parse with http: or https: scheme
 *
 * The parser fails loudly on any unknown mode value or invalid URL — silent
 * degradation here would leave a gateway un-discoverable in production.
 */

import { createParseEnv, EnvError, type EnvSource } from "./env.ts";

const HOSTNAME_MODE_VAR = "AJS_GATEWAY_HOSTNAME_MODE";
const COORDINATOR_URL_VAR = "AJS_GATEWAY_COORDINATOR_URL";
const DEFAULT_HOSTNAME_MODE = "resolvable" as const;
const VALID_HOSTNAME_MODES = ["resolvable", "null"] as const;

export type HostnameMode = (typeof VALID_HOSTNAME_MODES)[number];

export interface RemoteGatewayEnvConfig {
  hostnameMode: HostnameMode;
  /** Present iff hostnameMode === "null". */
  coordinatorUrl?: string;
}

function isHostnameMode(value: string): value is HostnameMode {
  return (VALID_HOSTNAME_MODES as readonly string[]).includes(value);
}

function parseCoordinatorUrl(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new EnvError(COORDINATOR_URL_VAR, `is required when ${HOSTNAME_MODE_VAR}="null"`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EnvError(COORDINATOR_URL_VAR, `cannot parse "${raw}" as a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EnvError(
      COORDINATOR_URL_VAR,
      `must use http: or https: protocol (got "${url.protocol}")`,
    );
  }
  return raw;
}

export function resolveRemoteGatewayEnv(
  env: Record<string, string | undefined>,
): RemoteGatewayEnvConfig {
  const parseEnv = createParseEnv(env as EnvSource);

  const rawMode = parseEnv(HOSTNAME_MODE_VAR, DEFAULT_HOSTNAME_MODE).string();
  if (!isHostnameMode(rawMode)) {
    throw new EnvError(
      HOSTNAME_MODE_VAR,
      `must be one of ${VALID_HOSTNAME_MODES.map((m) => `"${m}"`).join(", ")} (got "${rawMode}")`,
    );
  }

  if (rawMode === "null") {
    const coordinatorUrl = parseCoordinatorUrl(env[COORDINATOR_URL_VAR]);
    return { hostnameMode: "null", coordinatorUrl };
  }

  return { hostnameMode: "resolvable" };
}
