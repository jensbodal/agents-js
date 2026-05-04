/**
 * Built-in tool definitions for the default registry.
 *
 * The three primitives (two memory + one subagent) are registered into the
 * default registry by {@link registerBuiltins}. This is the core
 * proof — calling `findTools("search memories")` after `registerBuiltins()`
 * returns the searchMemories tool and `findTools("spawn a subagent")`
 * returns the SpawnAgent tool rather than only external tools that
 * consumers register later.
 *
 * Bootstrap is explicit: each consumer (binaries, CLI entry points, and
 * the test harness) must call {@link registerBuiltins} before relying on
 * the default registry. Library modules within `@agents-js/tools` should
 * NOT call this — only application bootstrap code should.
 */

import { searchDocs } from "./primitives/search-docs.ts";
import { searchMemories } from "./primitives/search-memories.ts";
import { spawnAgent } from "./primitives/spawn-agent.ts";
import { defaultRegistry } from "./registry.ts";
import type { ToolDefinition } from "./types.ts";

export const searchMemoriesTool: ToolDefinition = {
  name: "searchMemories",
  description: "Search agent memory files under .agents/<name>/ in the workspace",
  keywords: ["memory", "memories", "agent", "notes", "rule", "prior", "recall"],
  invoke: async (input) => {
    const { query, workspaceRoot } = input as { query: string; workspaceRoot: string };
    return searchMemories({ query, workspaceRoot });
  },
};

export const searchDocsTool: ToolDefinition = {
  name: "searchDocs",
  description: "Search markdown docs across the document root for a query string",
  keywords: ["doc", "docs", "hub", "vault", "search", "file", "plan", "spec"],
  invoke: async (input) => {
    const { query, hubRoot } = input as { query: string; hubRoot: string };
    return searchDocs({ query, hubRoot });
  },
};

export const spawnAgentTool: ToolDefinition = {
  // PascalCase tool-name reserved for the capability label (agent-facing);
  // the TS SDK export is `spawnAgent` (camelCase) per the convention lock
  // in df301ef. See spawn-agent-design-2026-04-22.md §Naming.
  name: "SpawnAgent",
  description:
    "Dispatch a subagent session for a bounded subtask and return its summary + provenance",
  keywords: ["spawn", "subagent", "dispatch", "subtask", "agent", "child", "delegate"],
  invoke: async (input) => {
    const { subtask, ...options } = input as { subtask: string } & Record<string, unknown>;
    return spawnAgent(subtask, options as Parameters<typeof spawnAgent>[1]);
  },
};

/**
 * Register the three built-in primitives into the default registry.
 *
 * Idempotent: registering the same name twice overwrites the prior entry,
 * so callers may safely invoke this from any bootstrap path. Re-registering
 * is benign because the tool definitions are module-level constants.
 */
export function registerBuiltins(): void {
  defaultRegistry.register(searchMemoriesTool);
  defaultRegistry.register(searchDocsTool);
  defaultRegistry.register(spawnAgentTool);
}
