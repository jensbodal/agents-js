import { buildAgentCardBaseUrl } from "@agents-js/a2a";

export const gatewayDiscoveryHost = "127.0.0.1";

export interface GatewayDiscovery {
  gatewayCardUrl: string;
  gatewayUrl: string;
  gatewayWsUrl: string;
  httpPort: number;
  host: string;
  wsPort: number;
}

// `Number.parseInt` is permissive: it accepts leading `+`, decimals (truncating
// "3.14" to 3), trailing garbage ("3000abc" to 3000), and `0x` hex prefixes
// (parsing "0x10" as 0 because "x" terminates digit scanning under the
// explicit `10` radix passed below; without that radix parseInt would
// auto-detect hex and return 16). Port strings flow from user-supplied env
// vars (e.g. GATEWAY_PORT) and CLI input, so we need exact-shape validation
// before delegating to parseInt. The regex is the
// most concise way to express "one or more ASCII digits, nothing else" — a
// non-regex alternative (`[...trimmed].every(...)`) reads as more imperative
// and adds an array allocation per call.
const PORT_DIGIT_ONLY = /^\d+$/;

export function parseGatewayPort(value: string, label: string): number {
  const trimmed = value.trim();
  if (!PORT_DIGIT_ONLY.test(trimmed)) {
    throw new Error(`[Gateway] Invalid ${label} "${value}". Expected an integer 0-65535.`);
  }

  const port = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`[Gateway] Invalid ${label} "${value}". Expected an integer 0-65535.`);
  }

  return port;
}

export function resolveGatewayPort(options: {
  cliPort?: number;
  configPort?: number;
  envPort?: string | undefined;
}): number {
  if (options.cliPort !== undefined) {
    return options.cliPort;
  }

  if (options.envPort !== undefined && options.envPort.trim() !== "") {
    return parseGatewayPort(options.envPort, "PORT");
  }

  if (options.configPort !== undefined) {
    return options.configPort;
  }

  return 0;
}

export function normalizeGatewayPublicUrl(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`[Gateway] Invalid ${label}: expected a non-empty URL.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`[Gateway] Invalid ${label} "${value}". Expected a valid URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`[Gateway] Invalid ${label} "${value}". Expected an http:// or https:// URL.`);
  }

  if (parsed.search || parsed.hash) {
    throw new Error(
      `[Gateway] Invalid ${label} "${value}". Query strings and fragments are not supported.`,
    );
  }

  return parsed.toString();
}

export function resolveGatewayPublicUrl(options: {
  hostname?: string;
  port: number;
  publicUrl?: string;
}): string {
  if (options.publicUrl !== undefined) {
    return normalizeGatewayPublicUrl(options.publicUrl, "publicUrl");
  }

  return buildAgentCardBaseUrl(options.port, options.hostname);
}

export function buildGatewayDiscovery(
  httpPort: number,
  wsPort: number,
  host = gatewayDiscoveryHost,
): GatewayDiscovery {
  const gatewayUrl = `http://${host}:${httpPort}`;
  const gatewayWsUrl = `ws://${host}:${wsPort}`;
  return {
    host,
    httpPort,
    wsPort,
    gatewayUrl,
    gatewayWsUrl,
    gatewayCardUrl: `${gatewayUrl}/.well-known/agent-card.json`,
  };
}

export function formatGatewayDiscoveryLines(discovery: GatewayDiscovery): string[] {
  return [
    `[Gateway] Gateway URL: ${discovery.gatewayUrl}`,
    `[Gateway] Gateway WS URL: ${discovery.gatewayWsUrl}`,
  ];
}
