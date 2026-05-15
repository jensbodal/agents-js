import type { AgentCard } from "@a2a-js/sdk";
import type { InitializeResponse } from "@agents-js/acp";
import { CURRENT_A2A_PROTOCOL_VERSION } from "./protocol.ts";

const DEFAULT_GATEWAY_CARD_URL = "http://127.0.0.1";
const DEFAULT_GATEWAY_CARD_VERSION = "1.0.0";
const DEFAULT_GATEWAY_INPUT_MODES = ["text"];
const DEFAULT_GATEWAY_OUTPUT_MODES = ["text"];

export interface DiscoveredResource {
  name?: string;
  uri: string;
}

export interface DiscoveredPrompt {
  description?: string;
  name: string;
}

/**
 * One entry in the gateway agent-card's `capabilities.harnesses` array.
 *
 * Federated A2A peers consume this to learn which curated harnesses the
 * gateway can route to without trial-and-error. `primary` marks the
 * default routing target (operator-pinned); `ready` reflects whether
 * the harness's ACP child has been spawned + handshake-completed and
 * flips per spawn/exit on the live agent-card surface.
 */
export interface HarnessCapabilityEntry {
  /** Curated harness id (e.g. "opencode", "gemini"). */
  id: string;
  /** Human-readable display name (e.g. "OpenCode ACP"). */
  displayName: string;
  /** True for the primary harness (first configured, used for default routing). */
  primary: boolean;
  /** True when the ACP child has been spawned and handshake completed. */
  ready: boolean;
}

export type GatewayAgentCapabilities = AgentCard["capabilities"] & {
  "text-to-text"?: Record<string, unknown>;
  harnesses?: HarnessCapabilityEntry[];
  multimodal?: boolean;
  prompts?: DiscoveredPrompt[];
  resources?: DiscoveredResource[];
  streaming?: boolean;
};

export type GatewayAgentCard = Omit<AgentCard, "capabilities"> & {
  capabilities: GatewayAgentCapabilities;
};

export type GatewayCardInput = Omit<
  Partial<GatewayAgentCard>,
  "name" | "description" | "capabilities"
> & {
  capabilities?: GatewayAgentCapabilities;
  description: string;
  name: string;
};

export function buildAgentCard(input: GatewayCardInput): GatewayAgentCard {
  return {
    url: DEFAULT_GATEWAY_CARD_URL,
    version: DEFAULT_GATEWAY_CARD_VERSION,
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    skills: [],
    defaultInputModes: [...DEFAULT_GATEWAY_INPUT_MODES],
    defaultOutputModes: [...DEFAULT_GATEWAY_OUTPUT_MODES],
    capabilities: {},
    ...input,
  };
}

/** Map ACP agentCapabilities and discovered resources into A2A AgentCard */
export function mapCapabilities(
  acpInfo: InitializeResponse,
  card: GatewayAgentCard,
  resources: DiscoveredResource[] = [],
  prompts: DiscoveredPrompt[] = [],
): void {
  const capabilities = card.capabilities;
  capabilities.streaming = true;

  if (acpInfo.agentCapabilities) {
    if (acpInfo.agentCapabilities.promptCapabilities?.image) {
      capabilities.multimodal = true;
    }
  }

  // Extend card with custom discovered arrays if requested
  if (resources.length > 0) {
    capabilities.resources = resources.map((r) => ({
      uri: r.uri,
      name: r.name,
    }));
  }

  if (prompts.length > 0) {
    capabilities.prompts = prompts.map((p) => ({
      name: p.name,
      description: p.description,
    }));
  }
}
