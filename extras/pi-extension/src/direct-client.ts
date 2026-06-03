import {
  A2AClientProvider,
  type A2AEvent,
  extractA2AResponseText,
  type ResolvedAgentTarget,
} from "@agents-js/a2a-client";
import { createSharedAgentRegistry } from "@agents-js/a2a-client/node";
import { A2UI_SURFACE_EVENT_NAME } from "@agents-js/a2ui-types";
import type { AgentBridge, AgentTool, ProgressCallback } from "./types.ts";

interface ConnectedAgent {
  target: ResolvedAgentTarget;
  contextId: string;
}

/**
 * Direct A2A client bridge — imports `@agents-js/a2a-client` in-process
 * instead of spawning a subprocess. Lower latency, tighter coupling.
 *
 * Activate with `AGENTS_JS_PI_MODE=direct`.
 */
/**
 * Anything that is not an MCP-safe identifier character (alphanumeric,
 * underscore, hyphen). Regex avoids hand-rolling a per-char loop. Must
 * stay in sync with mcp-bridge/src/server.ts to ensure name parity.
 */
const MCP_TOOL_NAME_INVALID_CHARS = /[^a-zA-Z0-9_-]/g;

/** Match mcp-bridge/src/server.ts sanitizeToolName to ensure name parity. */
function sanitizeToolName(name: string): string {
  return name.replace(MCP_TOOL_NAME_INVALID_CHARS, "_");
}

export class DirectClient implements AgentBridge {
  private provider = new A2AClientProvider();
  private agents = new Map<string, ConnectedAgent>();
  private registry = createSharedAgentRegistry();

  async initialize(): Promise<void> {
    const agents = await this.registry.list();

    if (agents.length === 0) {
      return;
    }

    // Silently skip ACP-kind entries — pi-extension only bridges A2A agents.
    const a2aAgents = agents.filter((agent) => agent.kind === "a2a");

    const results = await Promise.allSettled(
      a2aAgents.map(async (agent) => {
        const target = await this.provider.connect({ url: agent.url });
        return { name: agent.name, target };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        this.agents.set(result.value.name, {
          target: result.value.target,
          contextId: crypto.randomUUID(),
        });
      }
      // Rejected agents are silently skipped — one unreachable agent
      // must not prevent the rest from being available.
    }
  }

  async listTools(): Promise<AgentTool[]> {
    const tools: AgentTool[] = [];
    for (const [name, agent] of this.agents) {
      tools.push({
        name: sanitizeToolName(name),
        description: agent.target.card.description || `Send a message to the ${name} agent`,
      });
    }
    return tools;
  }

  async callTool(name: string, message: string, onProgress?: ProgressCallback): Promise<string> {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`[pi-extension] Unknown agent: ${name}`);
    }

    // Subscribe to streaming events if caller wants progress updates
    let unsubscribe: (() => void) | undefined;
    if (onProgress) {
      unsubscribe = this.provider.subscribe((event: A2AEvent) => {
        if (event.type === "message.delta") {
          onProgress({ type: "streaming", text: event.text });
        } else if (event.type === "step.started") {
          onProgress({ type: "progress", text: `Tool: ${event.name ?? event.stepId}` });
        } else if (event.type === "custom" && event.name === A2UI_SURFACE_EVENT_NAME) {
          // Gateway emits this as AG-UI CUSTOM `{ value: {...} }`; the A2A
          // client renames `value` to `data` on the bus. Pass through
          // verbatim — pi-extension relays, it does not interpret A2UI.
          const payload = event.data as { surfaceId?: unknown; event?: unknown } | null;
          if (payload && typeof payload.surfaceId === "string") {
            onProgress({
              type: "a2ui",
              surfaceId: payload.surfaceId,
              event: payload.event,
            });
          }
        }
      });
    }

    try {
      const canStream = agent.target.capabilities.supportsStreaming;
      const result = await this.provider.sendTurn(agent.target, message, {
        contextId: agent.contextId,
        stream: canStream,
        blocking: !canStream,
      });

      // A2A 1.0 dropped the `kind` discriminator from Message; the
      // a2a-client helper distinguishes Message (`messageId`) from Task
      // (`id`) at the wire boundary and extracts the reply text.
      return extractA2AResponseText(result) || "(no response)";
    } finally {
      unsubscribe?.();
    }
  }

  async destroy(): Promise<void> {
    this.agents.clear();
  }
}
