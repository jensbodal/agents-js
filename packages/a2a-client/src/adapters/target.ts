import type { AgentCard } from "@a2a-js/sdk";

/**
 * Context passed to TargetAdapter hooks during card adaptation.
 */
export interface AdaptTargetContext {
  /** The external URL that was passed to the adapter factory. */
  externalUrl: string;
  /** The URL that was actually probed to retrieve the raw card. */
  probeUrl: string;
}

/**
 * Raw card shape returned by a non-standard agent probe endpoint.
 * Kept as a loose record to avoid over-constraining what Agent Zero returns.
 */
export type RawAgentCard = Record<string, unknown>;

/**
 * Result of a successful adapt flow.
 */
export interface AdaptedTarget {
  /** A fully A2A-compatible agent card with url rewritten to externalUrl. */
  card: AgentCard;
  /** The URL that was probed. */
  probeUrl: string;
  /** The Authorization header value, if the adapter provided one. */
  authHeader: string | null;
}

/**
 * Adapter interface for non-standard A2A agents.
 *
 * Implement this to teach `adaptTarget` how to:
 *  1. Find the agent card at a non-standard path (`probePath`)
 *  2. Optionally authenticate the probe (`authHeader`)
 *  3. Rewrite / normalize the raw card into A2A-compatible shape (`transformCard`)
 */
export interface TargetAdapter {
  /**
   * The well-known path to probe for the agent card.
   * Example: "/.well-known/agent.json" (Agent Zero native)
   * vs the A2A standard "/.well-known/agent-card.json"
   */
  probePath: string;

  /**
   * Optional hook that returns an Authorization header value for the probe
   * request. Return null to omit the header.
   *
   * Stub for DOT-280 derived-token flow — concrete implementations land later.
   */
  authHeader?(ctx: AdaptTargetContext): string | null;

  /**
   * Rewrite the raw card fetched from probePath into a valid AgentCard.
   * Must at minimum set card.url to ctx.externalUrl.
   */
  transformCard(raw: RawAgentCard, ctx: AdaptTargetContext): AgentCard;
}

/**
 * Options for adaptTarget. Allows injecting a custom fetch for testing.
 */
export interface AdaptTargetOptions {
  fetch?: (input: string | Request | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Orchestrates the probe → auth → transform pipeline for a given TargetAdapter.
 *
 * 1. Constructs the probe URL from baseUrl + adapter.probePath
 * 2. Calls adapter.authHeader (if defined) to get an Authorization value
 * 3. Fetches the raw card
 * 4. Calls adapter.transformCard to produce the final AgentCard
 *
 * @throws Error if the probe fetch fails or returns a non-ok status.
 */
export async function adaptTarget(
  adapter: TargetAdapter,
  baseUrl: string,
  options: AdaptTargetOptions = {},
): Promise<AdaptedTarget> {
  const fetchFn = options.fetch ?? globalThis.fetch;

  // Strip trailing slash then append probePath
  const origin = baseUrl.replace(/\/+$/, "");
  const probeUrl = `${origin}${adapter.probePath}`;

  const ctx: AdaptTargetContext = { externalUrl: baseUrl, probeUrl };

  const authHeader = adapter.authHeader ? adapter.authHeader(ctx) : null;

  const headers: Record<string, string> = { accept: "application/json" };
  if (authHeader) {
    headers.Authorization = authHeader;
  }

  const response = await fetchFn(probeUrl, { method: "GET", headers });

  if (!response.ok) {
    throw new Error(`[adaptTarget] Probe failed: GET ${probeUrl} → HTTP ${response.status}`);
  }

  const raw = (await response.json()) as RawAgentCard;
  const card = adapter.transformCard(raw, ctx);

  return { card, probeUrl, authHeader };
}
