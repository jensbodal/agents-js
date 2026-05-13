/**
 * Environment-driven configuration for the MCP bus bridge.
 *
 * The bridge is intentionally configured by env vars only — no
 * config file, no CLI flags beyond what `bin.ts` parses. This keeps
 * the deployment story simple (Claude Code `mcpServers.<name>.env`
 * just passes a map of strings) and matches the convention
 * `extras/plane` and `extras/matrix-bridge` already follow.
 */

const DEFAULT_GATEWAY_URL = "http://localhost:8080";
const DEFAULT_SUBSCRIBE_PATH = "/events";
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;

/** Resolved bridge configuration. All fields are non-null. */
export interface BridgeConfig {
  /** Base URL of the gateway exposing `/events`. */
  gatewayUrl: string;
  /** Path on the gateway. Default `/events`. */
  subscribePath: string;
  /**
   * Topic-prefix filter list. `["*"]` (or empty) forwards every
   * event; otherwise only events whose `type` starts with at least
   * one prefix are forwarded.
   */
  filterPrefixes: string[];
  /** Initial reconnect delay in ms after an SSE disconnect. */
  reconnectMinMs: number;
  /** Maximum reconnect delay in ms; backoff caps here. */
  reconnectMaxMs: number;
}

/**
 * Resolve {@link BridgeConfig} from a process-env-like map.
 *
 * Env vars:
 *  - `GATEWAY_BUS_URL` — base URL of the gateway. Default `http://localhost:8080`.
 *  - `GATEWAY_BUS_SUBSCRIBE_PATH` — path on the gateway. Default `/events`.
 *  - `GATEWAY_BUS_FILTER` — comma-separated topic prefixes, or `*`. Default `*`.
 *  - `GATEWAY_BUS_RECONNECT_MIN_MS` — initial reconnect delay. Default 1000.
 *  - `GATEWAY_BUS_RECONNECT_MAX_MS` — max reconnect delay. Default 60000.
 *
 * Returns a fully-populated config; throws if a numeric env var is
 * supplied but does not parse.
 */
export function resolveBridgeConfigFromEnv(env: Record<string, string | undefined>): BridgeConfig {
  const gatewayUrl = (env.GATEWAY_BUS_URL ?? DEFAULT_GATEWAY_URL).trim();
  const subscribePath = (env.GATEWAY_BUS_SUBSCRIBE_PATH ?? DEFAULT_SUBSCRIBE_PATH).trim();
  const filterRaw = (env.GATEWAY_BUS_FILTER ?? "*").trim();
  const filterPrefixes =
    filterRaw.length === 0
      ? ["*"]
      : filterRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

  const reconnectMinMs = parseRequiredInt(
    env.GATEWAY_BUS_RECONNECT_MIN_MS,
    DEFAULT_RECONNECT_MIN_MS,
    "GATEWAY_BUS_RECONNECT_MIN_MS",
  );
  const reconnectMaxMs = parseRequiredInt(
    env.GATEWAY_BUS_RECONNECT_MAX_MS,
    DEFAULT_RECONNECT_MAX_MS,
    "GATEWAY_BUS_RECONNECT_MAX_MS",
  );
  if (reconnectMinMs > reconnectMaxMs) {
    throw new Error(
      `GATEWAY_BUS_RECONNECT_MIN_MS (${reconnectMinMs}) must be <= GATEWAY_BUS_RECONNECT_MAX_MS (${reconnectMaxMs})`,
    );
  }

  return {
    gatewayUrl,
    subscribePath,
    filterPrefixes,
    reconnectMinMs,
    reconnectMaxMs,
  };
}

function parseRequiredInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}
