/**
 * `@agents-js/tools` — unified tool surface for agents-js.
 *
 * Two externally-visible verbs ship together in one package because they
 * target the same problem (agents need to recall grounded context and pick
 * from a small set of actions) but at two different grains:
 *
 * - Shape 1 — {@link fetchContext} is a **coordinator**. It picks memory
 *   primitives based on query shape, runs them, and returns a ranked set of
 *   snippets plus a provenance record per the canonical 5-field Source
 *   schema. Agents call `fetchContext` when they need grounded prior state
 *   before answering.
 *
 * - Shape 2 — {@link findTools} is a **discovery surface**. It queries an
 *   in-memory registry and returns 1–3 matching tools. The registry is
 *   populated by {@link registerBuiltins} with the two memory primitives
 *   themselves, so `findTools("search hub for X")` returns {@link searchDocs}
 *   — the self-hosting proof referenced in the first-cycle plan.
 *
 * See the first-cycle plan at
 * `hub/agents-js/plans/first-week-plan-2026-04-21-final.md` for the design
 * brief and the readiness-gate rollout plan, and ADR 0002 for the
 * architecture decision record.
 */

export {
  registerBuiltins,
  searchDocsTool,
  searchMemoriesTool,
  spawnAgentTool,
} from "./builtins.ts";
export { fetchContext } from "./fetch-context.ts";
export { findTools } from "./find-tools.ts";
export { searchDocs } from "./primitives/search-docs.ts";
export { searchMemories } from "./primitives/search-memories.ts";
export {
  builtinCommandResolver,
  createSigilRegistry,
  type HandledResult,
  parseSigil,
  type ResolverResult,
  resolveSigil,
  type Sigil,
  type SigilContext,
  type SigilKind,
  type SigilRegistry,
  SigilResolutionError,
  type SigilResolver,
  UNHANDLED,
  type UnhandledResult,
} from "./primitives/sigil-registry.ts";
export {
  SPAWN_AGENT_DEFAULT_MAX_DEPTH,
  type SpawnAgentHints,
  SpawnAgentInvalidInputError,
  type SpawnAgentOptions,
  type SpawnAgentResult,
  type SpawnAgentStatus,
  spawnAgent,
  translateGatewayResult,
} from "./primitives/spawn-agent.ts";
export { createRegistry, defaultRegistry } from "./registry.ts";
export { routeFetchContext, scoreSnippet, scoreTool, tokenize } from "./router.ts";
export {
  applyRedaction,
  createJsonlFileSink,
  createMemorySink,
  createNoopSink,
  REDACTION_SENTINEL,
  TOOL_CALL_TRACE_SCHEMA_VERSION,
  type ToolCallTrace,
  TraceEmitter,
  type TraceEmitterOptions,
  type TraceInvocationContext,
  type TraceSink,
  wrapToolWithTrace,
} from "./trace.ts";
export type {
  Confidence,
  FetchContextHint,
  FetchContextOptions,
  FetchContextResult,
  FindToolsOptions,
  RedactionSpec,
  Snippet,
  Source,
  SourceType,
  ToolDefinition,
  ToolRegistry,
} from "./types.ts";
