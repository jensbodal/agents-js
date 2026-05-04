/**
 * In-memory registry for Shape 2 tool discovery.
 *
 * The default registry (`defaultRegistry`) is populated at module load with
 * the two memory primitives (searchMemories, searchDocs) exposed as tools —
 * the self-hosting proof referenced in the plan doc. Consumers who want
 * isolation (tests, specific-agent scopes) should create their own via
 * {@link createRegistry} and pass it through `findTools` options.
 */

import { scoreTool } from "./router.ts";
import type { ToolDefinition, ToolRegistry } from "./types.ts";

/**
 * Create a fresh, isolated in-memory {@link ToolRegistry}.
 *
 * The module-level {@link defaultRegistry} is populated at load time with
 * the two memory primitives. Callers that want isolation (tests,
 * per-agent scopes, per-session registries) construct their own via
 * `createRegistry()` and pass it to {@link findTools} via `options.registry`.
 */
export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      if (!tool.name || tool.name.trim().length === 0) {
        throw new Error("Tool name must be a non-empty string");
      }
      tools.set(tool.name, tool);
    },
    list(): ToolDefinition[] {
      return Array.from(tools.values());
    },
    find(query: string, limit = 3): ToolDefinition[] {
      const scored: Array<{ tool: ToolDefinition; score: number }> = [];
      for (const tool of tools.values()) {
        const score = scoreTool(tool, query);
        if (score > 0) {
          scored.push({ tool, score });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map((entry) => entry.tool);
    },
    clear(): void {
      tools.clear();
    },
  };
}

/**
 * Module-level registry. Populated lazily via {@link ensureDefaultPopulated}
 * so primitive files can import the registry without triggering their own
 * re-entry at import time.
 */
export const defaultRegistry: ToolRegistry = createRegistry();
