/**
 * Shared types for `@agents-js/tools`.
 *
 * The provenance schema here is the canonical Source shape for every
 * downstream primitive and tool. See the first-cycle plan for rationale.
 */

/**
 * What kind of source a result came from. Kept narrow + explicit so the
 * router + consumers can filter by source class without string parsing.
 */
export type SourceType = "matrix" | "hub-file" | "agent-msg" | "cognee" | "web" | "tool";

/**
 * Confidence classification for a source.
 *
 * - `responsible` — the current, canonical source of truth for this datum.
 * - `supporting` — corroborating context, may be stale or derivative.
 *
 * Callers that want authoritative answers filter to `responsible`.
 */
export type Confidence = "responsible" | "supporting";

/**
 * Canonical 5-field provenance record. Every result must populate all five.
 *
 * `observed_at` is the source-side observation timestamp (file mtime, Matrix
 * event origin, agent-msg created_at, etc). `retrieved_at` is when _this_
 * query read the source. Both are ISO 8601.
 */
export interface Source {
  source_type: SourceType;
  source_ref: string;
  observed_at: string;
  retrieved_at: string;
  confidence: Confidence;
}

/**
 * A snippet of matched text from a source, carrying a back-index into
 * `sources` and a relevance score (0..n, higher = better).
 */
export interface Snippet {
  text: string;
  source_index: number;
  score: number;
}

/**
 * Result of a `fetchContext` call.
 */
export interface FetchContextResult {
  snippets: Snippet[];
  sources: Source[];
}

/**
 * Routing hint for `fetchContext`. `"both"` runs primitives in parallel and
 * merges. Default routing picks a preference from query-shape heuristics.
 */
export type FetchContextHint = "prefer-memories" | "prefer-docs" | "both";

/**
 * Options for `fetchContext`. `workspaceRoot` / `hubRoot` exist so tests can
 * point primitives at fixture directories without monkey-patching cwd.
 */
export interface FetchContextOptions {
  /** Router preference override. */
  hint?: FetchContextHint;
  /** Root under which `.agents/<name>/*.md` live. Defaults to `process.cwd()`. */
  workspaceRoot?: string;
  /** Root of the hub vault. Defaults to the canonical path for local dev. */
  hubRoot?: string;
  /** Maximum snippets to return. Default: 10. */
  limit?: number;
  /** Timestamp source for `retrieved_at` (test seam). */
  now?: () => Date;
}

/**
 * Per-tool redaction spec. Applied by the trace emitter before persistence
 * so secret fields never land in the append-only log. See
 * `tool-call-trace-schema-2026-04-21.md` §3 for design rationale.
 *
 * The spec lists top-level keys whose values should be replaced with the
 * sentinel string `"REDACTED"` prior to emission. Nested / recursive
 * redaction is a v0.2 concern; v0.1 is top-level only.
 *
 * An empty spec (or `{}`) signals "tool author confirms there are no
 * secrets here" — explicit, not a default. Tools that actually have
 * secrets MUST populate the appropriate keys; the schema places that
 * responsibility on the tool declaration.
 */
export interface RedactionSpec {
  /** Top-level keys in `args` whose values to replace with `"REDACTED"`. */
  args?: readonly string[];
  /** Top-level keys in `result` whose values to replace with `"REDACTED"`. */
  result?: readonly string[];
}

/**
 * Contract for a single tool in the Shape 2 registry.
 *
 * `keywords` bias the router; they do not need to be exhaustive because
 * `description` is also scored. `invoke` is deliberately `unknown` in + out:
 * each tool specifies its own input/output schema in prose or downstream
 * typings. The registry is a discovery layer, not a type-checker.
 *
 * `redaction`, when present, is consumed by the trace emitter (see
 * `./trace.ts`) to scrub secret fields before persisting a tool-call-trace
 * record. Tools that don't opt in are NOT auto-redacted — absence means
 * "no emission-time scrubbing configured" rather than "no secrets exist."
 * Callers wrapping tools with {@link wrapToolWithTrace} should audit each
 * tool's args/result shape and populate the spec where needed.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  keywords?: string[];
  invoke: (input: unknown) => Promise<unknown>;
  redaction?: RedactionSpec;
}

/**
 * Options for `findTools`.
 */
export interface FindToolsOptions {
  /** Max tools to return. Default: 3. */
  limit?: number;
  /** Override the module-level default registry (useful for testing). */
  registry?: ToolRegistry;
}

/**
 * In-memory registry surface. The default module-level registry populates
 * at load time with the two memory primitives; callers may instantiate an
 * isolated registry via {@link createRegistry}.
 */
export interface ToolRegistry {
  register(tool: ToolDefinition): void;
  list(): ToolDefinition[];
  find(query: string, limit?: number): ToolDefinition[];
  /**
   * Remove every registered tool. Used by tests that share `defaultRegistry`
   * to restore a known pre-test state in `afterAll`. Application code does
   * not normally need this — register-only mutation matches the
   * "populate-once at bootstrap" model.
   */
  clear(): void;
}
