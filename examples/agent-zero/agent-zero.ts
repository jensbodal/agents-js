import type { AgentCard } from "@a2a-js/sdk";
import type { AdaptTargetContext, RawAgentCard, TargetAdapter } from "@agents-js/a2a-client";

/**
 * Options for the Agent Zero polyfill adapter.
 */
export interface AgentZeroAdapterOptions {
  /**
   * The operator-configured external URL for this Agent Zero instance.
   * Agent Zero reports url: `http://localhost:8000` internally; this value
   * replaces it in the normalized AgentCard.
   *
   * Example: "https://agent-zero.example.ts.net"
   */
  externalUrl: string;

  /**
   * Optional Bearer token for authenticating probe requests.
   * When provided, the Authorization header is set to "Bearer <token>".
   * When omitted, authHeader returns null.
   */
  token?: string;
}

/** Agent Zero reports this URL internally; we always replace it. */
const AGENT_ZERO_INTERNAL_URL = "http://localhost:8000";

/**
 * The path where Agent Zero exposes its native agent descriptor.
 * Not the A2A standard "/.well-known/agent-card.json".
 */
const AGENT_ZERO_PROBE_PATH = "/.well-known/agent.json";

/**
 * Minimum required AgentCard fields per the A2A spec.
 * Defaults applied when Agent Zero's raw card omits them.
 */
const AGENT_ZERO_DEFAULT_PROTOCOL_VERSION = "0.3.0";

/**
 * Factory that creates a TargetAdapter for Agent Zero instances.
 *
 * Behavior:
 * - Probes /.well-known/agent.json (not the A2A standard -card.json path)
 * - Rewrites card.url from `http://localhost:8000` to externalUrl
 * - Normalizes the raw card shape to A2A-compatible AgentCard
 * - Provides authHeader hook (returns "Bearer <token>" or null)
 *
 * Pass `token` for simple static bearer auth.
 */
export function agentZeroAdapter(options: AgentZeroAdapterOptions): TargetAdapter {
  const { token } = options;

  return {
    probePath: AGENT_ZERO_PROBE_PATH,

    authHeader(_ctx: AdaptTargetContext): string | null {
      if (token) {
        return `Bearer ${token}`;
      }
      return null;
    },

    transformCard(raw: RawAgentCard, ctx: AdaptTargetContext): AgentCard {
      return normalizeAgentZeroCard(raw, ctx.externalUrl);
    },
  };
}

/**
 * Rewrite Agent Zero's raw card into an A2A-compatible AgentCard.
 *
 * Agent Zero's card may:
 * - Have url = `http://localhost:8000` (always replaced)
 * - Omit protocolVersion (filled with default)
 * - Omit skills / defaultInputModes / defaultOutputModes (filled with defaults)
 * - Have name/description (preserved as-is)
 */
function normalizeAgentZeroCard(raw: RawAgentCard, externalUrl: string): AgentCard {
  const name = typeof raw.name === "string" && raw.name.length > 0 ? raw.name : "agent-zero";

  const description = typeof raw.description === "string" ? raw.description : "Agent Zero instance";

  const version = typeof raw.version === "string" ? raw.version : "1.0.0";

  const protocolVersion =
    typeof raw.protocolVersion === "string"
      ? raw.protocolVersion
      : AGENT_ZERO_DEFAULT_PROTOCOL_VERSION;

  const skills = Array.isArray(raw.skills) ? raw.skills : [];

  const defaultInputModes = Array.isArray(raw.defaultInputModes) ? raw.defaultInputModes : ["text"];

  const defaultOutputModes = Array.isArray(raw.defaultOutputModes)
    ? raw.defaultOutputModes
    : ["text"];

  const rawUrl = typeof raw.url === "string" ? raw.url : AGENT_ZERO_INTERNAL_URL;
  // Replace localhost self-report with operator-configured external URL
  const url = rawUrl === AGENT_ZERO_INTERNAL_URL ? externalUrl : rawUrl;

  const capabilities =
    raw.capabilities !== null &&
    typeof raw.capabilities === "object" &&
    !Array.isArray(raw.capabilities)
      ? (raw.capabilities as AgentCard["capabilities"])
      : {};

  return {
    name,
    description,
    url,
    version,
    protocolVersion,
    skills,
    defaultInputModes,
    defaultOutputModes,
    capabilities,
  };
}
