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
 *
 * Federation contract: every entry has an implicit origin. Existing
 * single-host gateways emit entries with no `source` field; those are
 * treated as `source: "local"` for back-compat — the parent gateway
 * spawns the ACP child itself. Federated entries carry `source:
 * "remote"` together with a `remote` envelope describing the child
 * gateway that actually owns the process; federation peers dispatch
 * to that child (directly via `remote.gatewayUrl` when the hostname
 * is resolvable, or indirectly via `remote.coordinatorUrl` when the
 * child's hostname is null) instead of asking the parent to spawn.
 */
export type HarnessCapabilityEntry = HarnessCapabilityEntryBase &
  (HarnessLocalOrigin | HarnessRemoteOrigin);

interface HarnessCapabilityEntryBase {
  /** Curated harness id (e.g. "opencode", "gemini"). */
  id: string;
  /** Human-readable display name (e.g. "OpenCode ACP"). */
  displayName: string;
  /** True for the primary harness (first configured, used for default routing). */
  primary: boolean;
  /** True when the ACP child has been spawned and handshake completed. */
  ready: boolean;
}

interface HarnessLocalOrigin {
  /**
   * Where this harness's backing process actually runs.
   * Omitted defaults to "local" for back-compat — every existing
   * card from a single-host gateway is implicitly source: "local".
   */
  source?: "local";
  remote?: never;
}

interface HarnessRemoteOrigin {
  source: "remote";
  /**
   * Federation envelope for remote-backed harness entries. Present
   * iff source === "remote"; absent otherwise.
   *
   * Federation peers dispatch to the child gateway at gatewayUrl
   * (or via the coordinator when hostnameMode === "null") rather
   * than asking the parent gateway to spawn locally.
   */
  remote: {
    /** Externally-routable URL of the child gateway, or coordinator-rewritten URL when hostnameMode === "null". */
    gatewayUrl: string;
    /** Hostname-resolution mode the child gateway is operating under. */
    hostnameMode: "resolvable" | "null";
    /** Coordinator endpoint; present iff hostnameMode === "null". */
    coordinatorUrl?: string;
    /** Child gateway's stable id (matches its own card.name). */
    childAgentId: string;
  };
}

export type GatewayAgentCapabilities = NonNullable<AgentCard["capabilities"]> & {
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
    // A2A 1.0: transport is declared via `supportedInterfaces`. The
    // placeholder URL is replaced with the actually-bound authority once the
    // server allocates a port (see `UniversalA2AServer.finalizeDefaultUrl`).
    supportedInterfaces: [
      {
        url: DEFAULT_GATEWAY_CARD_URL,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
      },
    ],
    provider: undefined,
    version: DEFAULT_GATEWAY_CARD_VERSION,
    capabilities: { extensions: [] },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: [...DEFAULT_GATEWAY_INPUT_MODES],
    defaultOutputModes: [...DEFAULT_GATEWAY_OUTPUT_MODES],
    skills: [],
    signatures: [],
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
