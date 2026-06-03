import type { A2ATransport, ResolvedAgentTarget } from "@agents-js/a2a-client";
import {
  A2AClientProvider,
  extractLatestAgentText,
  extractMessageText,
} from "@agents-js/a2a-client";
import type { SkillMeta } from "@agents-js/skills";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import pkg from "../package.json";
import { DiscoveryIndex } from "./discovery.ts";

/**
 * Configuration for a single A2A agent endpoint that the bridge will expose
 * as an MCP tool.
 */
export interface AgentEndpoint {
  /** Human-readable agent name (becomes the MCP tool name). */
  name: string;
  /** Base URL of the A2A agent (used for card discovery and message sending). */
  url: string;
}

/**
 * Full bridge configuration: a list of agent endpoints to expose.
 */
export interface BridgeConfig {
  agents: AgentEndpoint[];
  /**
   * Optional list of skills (typically produced by `@agents-js/skills`
   * `listSkills()`) to surface in `tool_search`. Skills are NOT
   * invocable via `tools/call` — they are discoverable references
   * pointing at on-disk SKILL.md content. Callers that want an
   * invocation path should bridge the skill into their own tool.
   */
  skills?: SkillMeta[];
  /**
   * When `true`, bridged agent tools start disabled and are only
   * exposed via `tools/list` after `load_tool` is called. Default
   * `false` preserves the pre-discovery behaviour: every agent tool
   * is enumerable immediately.
   */
  progressiveDiscovery?: boolean;
}

interface ConnectedAgent {
  endpoint: AgentEndpoint;
  target: ResolvedAgentTarget;
  contextId: string;
}

/**
 * Anything that is not an MCP-safe identifier character (alphanumeric,
 * underscore, hyphen). A regex is the natural way to express "negated
 * character class"; the alternative is iterating per-char and rebuilding
 * the string.
 */
const MCP_TOOL_NAME_INVALID_CHARS = /[^a-zA-Z0-9_-]/g;

function sanitizeToolName(name: string): string {
  return name.replace(MCP_TOOL_NAME_INVALID_CHARS, "_");
}

const SEARCH_TOOL_NAME = "tool_search";
const LOAD_TOOL_NAME = "load_tool";

/**
 * Thin wrapper around `McpServer.tool()` that pins the return type and
 * bypasses the SDK's inline-zod-schema overloads that otherwise trigger
 * TS2589 ("type instantiation is excessively deep"). Behaviour is
 * identical to calling `server.tool(...)` directly — the SDK checks
 * argument shapes at runtime.
 */
// biome-ignore lint/suspicious/noExplicitAny: SDK generics blow up with inline zod shapes
type LooseToolFn = (this: McpServer, ...xs: any[]) => RegisteredTool;

function registerBridgeTool(
  server: McpServer,
  name: string,
  description: string,
  // biome-ignore lint/suspicious/noExplicitAny: zod raw-shape or plain object
  inputSchema: Record<string, any>,
  // biome-ignore lint/suspicious/noExplicitAny: SDK callback shape varies with schema
  handler: (args: any) => any,
): RegisteredTool {
  const fn = server.tool as unknown as LooseToolFn;
  return fn.call(server, name, description, inputSchema, handler);
}

/**
 * Create and configure an MCP server that bridges A2A agents as MCP tools.
 *
 * For each agent in the config, connects to the A2A endpoint, fetches
 * its agent card, and registers an MCP tool. Tool calls are forwarded
 * via `A2AClientProvider.sendTurn()` with a stable contextId per agent.
 *
 * The bridge additionally registers two progressive-discovery tools,
 * `tool_search` and `load_tool`, that let agents enumerate the
 * available toolset on demand instead of consuming it up front. In
 * `progressiveDiscovery: true` mode, agent tools start `disable()`d
 * and must be surfaced via `load_tool`; the MCP SDK automatically
 * emits `notifications/tools/list_changed` when they flip.
 *
 * @param config - Bridge configuration: agents, optional skills for
 *   discoverability, and the progressive-discovery flag.
 * @param transport - Optional custom A2A transport (defaults to SdkA2ATransport).
 * @returns A configured McpServer ready to be connected to a transport.
 */
export async function createBridgeServer(
  config: BridgeConfig,
  transport?: A2ATransport,
): Promise<McpServer> {
  const provider = new A2AClientProvider(transport);
  const discoveryIndex = new DiscoveryIndex();

  const server = new McpServer({
    name: "agents-js-mcp-bridge",
    version: pkg.version,
  });

  const results = await Promise.allSettled(
    config.agents.map(async (endpoint): Promise<ConnectedAgent> => {
      const target = await provider.connect({ url: endpoint.url });
      return { endpoint, target, contextId: crypto.randomUUID() };
    }),
  );

  const connectedAgents: ConnectedAgent[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") {
      connectedAgents.push(result.value);
    } else {
      const name = config.agents[index]?.name ?? "unknown";
      console.error(
        `[mcp-bridge] Failed to connect to agent "${name}": ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      );
    }
  }

  // Track registered agent tools so load_tool can enable them on demand.
  const agentTools = new Map<string, RegisteredTool>();

  for (const agent of connectedAgents) {
    const toolName = sanitizeToolName(agent.endpoint.name);
    const description =
      agent.target.card.description || `Send a message to the ${agent.endpoint.name} agent`;

    discoveryIndex.add({
      name: toolName,
      description,
      source: "agent",
    });

    const inputSchema = { message: z.string() };
    const registered = registerBridgeTool(
      server,
      toolName,
      description,
      inputSchema,
      async ({ message }: { message: string }) => {
        // Principled keep (AJS-92): MCP `tools/call` is request/response
        // by spec — the protocol has no streaming response shape for
        // tool results. The bridge MUST collect the terminal text into a
        // single `content: [{ type: "text" }]` payload before returning.
        // Unlike the @mention middleware and host-executor A2A dispatch
        // (which were flipped to streaming-by-default in AJS-92), this
        // site intentionally keeps `stream: false, blocking: true`: any
        // intermediate stream would be discarded, and the blocking flag
        // ensures non-streaming servers return the terminal result
        // in-band rather than asking us to poll. Do not flip without a
        // matching change to the MCP tool-response spec.
        const result = await provider.sendTurn(agent.target, message, {
          contextId: agent.contextId,
          stream: false,
          blocking: true,
        });

        // A2A 1.0 dropped the `kind` discriminator from the proto model.
        // `A2ASendResult` is `Message | Task`; a `Message` carries
        // `messageId`/`role`, a `Task` carries `status`/`artifacts`.
        const text =
          "messageId" in result ? extractMessageText(result) : extractLatestAgentText(result);

        return {
          content: [{ type: "text" as const, text: text || "(no response)" }],
        };
      },
    );

    agentTools.set(toolName, registered);

    if (config.progressiveDiscovery) {
      registered.disable();
    }
  }

  // Index skills (non-invocable references; they exist only as
  // search-surfaced metadata).
  for (const skill of config.skills ?? []) {
    discoveryIndex.add({
      name: skill.name,
      description: skill.description,
      source: "skill",
    });
  }

  // --- tool_search -----------------------------------------------------------
  // Returns matching entries from the in-memory discovery index. This
  // is a plain MCP tool — agents invoke it via `tools/call` and no new
  // protocol verb is introduced.
  registerBridgeTool(
    server,
    SEARCH_TOOL_NAME,
    "Search available tools and skills by substring match over name + description. " +
      "Returns lightweight metadata; use `load_tool` (progressive mode) or call the tool " +
      "directly via `tools/call` (default mode) once you know the name.",
    {
      query: z.string().describe("Substring to match (case-insensitive). Empty returns all."),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Maximum results to return. Defaults to 20, capped at 100."),
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const hits = discoveryIndex.search(query, { limit });
      const summary = hits
        .map((entry) => `- ${entry.name} [${entry.source}] — ${entry.description}`)
        .join("\n");
      const body = hits.length === 0 ? "(no matches)" : summary;

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${hits.length} entr${hits.length === 1 ? "y" : "ies"}:\n${body}`,
          },
        ],
        structuredContent: { results: hits },
      };
    },
  );

  // --- load_tool -------------------------------------------------------------
  // In progressive mode, agent tools start disabled. `load_tool` flips
  // an entry from `disable()` to `enable()`; the SDK fires
  // `notifications/tools/list_changed` so MCP clients re-read
  // `tools/list` and see the newly-available tool.
  //
  // In non-progressive mode this tool still works and is idempotent —
  // calling it on an already-enabled tool is a no-op with a friendly
  // message. This keeps the UX consistent across modes.
  registerBridgeTool(
    server,
    LOAD_TOOL_NAME,
    "Make a tool available for invocation. In progressive-discovery mode agent tools start " +
      "hidden; calling `load_tool(name)` enables them and triggers `tools/list_changed`. " +
      "In default mode this is idempotent.",
    {
      name: z.string().describe("The tool name returned by `tool_search`."),
    },
    async ({ name }: { name: string }) => {
      const entry = discoveryIndex.get(name);
      if (!entry) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `Unknown tool or skill: "${name}". ` +
                `Call \`tool_search\` to list available entries.`,
            },
          ],
        };
      }

      if (entry.source === "skill") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `"${name}" is a skill, not an invocable tool. ` +
                `Skills are reference material; read the SKILL.md directly.`,
            },
          ],
        };
      }

      const registered = agentTools.get(name);
      if (!registered) {
        // Present in discovery index but no backing MCP tool — should
        // not happen in current code paths, but the guard keeps the
        // error surface honest if future sources (e.g. "internal")
        // are added to the index without a matching registration.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `"${name}" is indexed but not backed by an MCP tool handler.`,
            },
          ],
        };
      }

      if (registered.enabled) {
        return {
          content: [
            {
              type: "text" as const,
              text: `"${name}" is already loaded and callable via \`tools/call\`.`,
            },
          ],
        };
      }

      registered.enable();
      return {
        content: [
          {
            type: "text" as const,
            text: `Loaded "${name}". It is now callable via \`tools/call\`.`,
          },
        ],
      };
    },
  );

  return server;
}
