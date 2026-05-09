import type { AgentCard } from "@a2a-js/sdk";
import type { AgentTargetInput, AgentTargetMode, CapabilitySummary } from "./types.ts";

export interface NormalizedAgentTargetInput {
  url: string;
  baseUrl: string;
  cardUrl: string;
  clientFactoryPath?: string;
  clientFactoryUrl: string;
  headers: Record<string, string>;
  mode: AgentTargetMode;
}

const WELL_KNOWN_CARD_SUFFIX = "/.well-known/agent-card.json";

function ensureHttp(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return `http://${url}`;
}

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "";
  }
  return pathname.replace(/\/+$/, "");
}

function dirnamePathname(pathname: string): string {
  const normalizedPath = normalizePathname(pathname);
  if (!normalizedPath) {
    return "";
  }

  const lastSlash = normalizedPath.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "";
  }

  return normalizedPath.slice(0, lastSlash);
}

function stripAgentCardSuffix(pathname: string): string {
  if (pathname.endsWith(WELL_KNOWN_CARD_SUFFIX)) {
    return pathname.slice(0, -WELL_KNOWN_CARD_SUFFIX.length);
  }
  return pathname;
}

function isCardPath(pathname: string): boolean {
  return pathname.endsWith(WELL_KNOWN_CARD_SUFFIX);
}

export function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (!key || !value) {
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

export function normalizeAgentTargetInput(input: AgentTargetInput): NormalizedAgentTargetInput {
  const url = ensureHttp(input.url.trim());
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";

  const autoDetectedMode: AgentTargetMode = isCardPath(parsed.pathname) ? "card" : "base";
  const mode = input.mode === undefined || input.mode === "auto" ? autoDetectedMode : input.mode;

  if (mode === "card" && !isCardPath(parsed.pathname)) {
    const normalizedCardPath = normalizePathname(parsed.pathname);
    const basePath = dirnamePathname(parsed.pathname);
    const cardUrl = `${parsed.origin}${normalizedCardPath}`;

    return {
      url,
      baseUrl: `${parsed.origin}${basePath}`,
      cardUrl,
      clientFactoryUrl: cardUrl,
      clientFactoryPath: "",
      headers: normalizeHeaders(input.headers),
      mode,
    };
  }

  const rawBasePath = mode === "card" ? stripAgentCardSuffix(parsed.pathname) : parsed.pathname;
  const basePath = normalizePathname(rawBasePath);
  const baseUrl = `${parsed.origin}${basePath}`;
  const cardPath = `${basePath}${WELL_KNOWN_CARD_SUFFIX}`;

  return {
    url,
    baseUrl,
    cardUrl: `${parsed.origin}${cardPath}`,
    clientFactoryUrl: baseUrl,
    headers: normalizeHeaders(input.headers),
    mode,
  };
}

/**
 * Returns an origin-level variant of `normalized` when the base path is non-empty.
 *
 * Used as a resolution fallback for the common misuse pattern where the
 * caller passes a JSON-RPC endpoint URL (e.g. `http://host/a2a`) instead
 * of the agent's base URL: the derived `<origin>/<path>/.well-known/agent-card.json`
 * 404s, but `<origin>/.well-known/agent-card.json` is served by the gateway.
 * Returns null when the input already targets the origin (no fallback to try).
 */
export function originCardFallback(
  normalized: NormalizedAgentTargetInput,
): NormalizedAgentTargetInput | null {
  if (normalized.mode !== "base") {
    return null;
  }
  const parsed = new URL(normalized.baseUrl);
  if (normalizePathname(parsed.pathname) === "") {
    return null;
  }
  const origin = parsed.origin;
  return {
    url: normalized.url,
    baseUrl: origin,
    cardUrl: `${origin}${WELL_KNOWN_CARD_SUFFIX}`,
    clientFactoryUrl: origin,
    clientFactoryPath: normalized.clientFactoryPath,
    headers: normalized.headers,
    mode: normalized.mode,
  };
}

export function summarizeCapabilities(card: AgentCard): CapabilitySummary {
  const inputModes = Array.isArray(card.defaultInputModes) ? [...card.defaultInputModes] : [];
  const outputModes = Array.isArray(card.defaultOutputModes) ? [...card.defaultOutputModes] : [];
  const capabilities = (card.capabilities ?? {}) as Record<string, unknown>;

  return {
    inputModes,
    outputModes,
    supportsTextInput: inputModes.includes("text") || inputModes.includes("text/plain"),
    supportsTextOutput: outputModes.includes("text") || outputModes.includes("text/plain"),
    supportsStreaming: capabilities.streaming === true,
    supportsPushNotifications: capabilities.pushNotifications === true,
    raw: card.capabilities,
  };
}

export function truncateText(value: string | undefined, limit: number = 2_000): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}…`;
}
