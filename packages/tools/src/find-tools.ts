/**
 * findTools — Shape 2 discovery surface.
 *
 * Returns a narrow list of tools (default limit: 3) matching the query.
 * Uses the shared router scorer so agents can predict results by reading
 * `scoreTool` in `router.ts`.
 */

import { defaultRegistry } from "./registry.ts";
import type { FindToolsOptions, ToolDefinition } from "./types.ts";

/**
 * Narrow tool-discovery surface (Shape 2).
 *
 * Returns up to `limit` tools (default 3) from an in-memory registry,
 * ranked by keyword overlap against each tool's name, keywords, and
 * description via the shared router scorer. Agents call `findTools`
 * before each turn to discover the narrow subset of actions relevant to
 * the current query rather than being handed the full registry.
 *
 * The default registry is populated at module load with the two memory
 * primitives (`searchMemories`, `searchDocs`) so the surface is usable
 * without any external registration step. Consumers may pass their own
 * isolated registry via `options.registry`.
 *
 * @param query - Free-text query string.
 * @param options - Optional `limit` (default 3) and `registry` override.
 * @returns An array of matching tool definitions, each directly
 * invokable via `tool.invoke(input)`.
 */
export async function findTools(
  query: string,
  options: FindToolsOptions = {},
): Promise<ToolDefinition[]> {
  const registry = options.registry ?? defaultRegistry;
  const limit = options.limit ?? 3;
  return registry.find(query, limit);
}
