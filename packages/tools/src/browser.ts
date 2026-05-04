/**
 * Browser-safe entry point for `@agents-js/tools`.
 *
 * The memory primitives (`searchMemories`, `searchDocs`) read from the
 * filesystem via `node:fs/promises` and cannot run in the browser. The
 * coordinator ({@link fetchContext}) inherits that constraint transitively.
 *
 * What IS safe to ship to bundlers:
 *
 * - {@link findTools} — pure query-over-registry, no I/O
 * - {@link createRegistry}, {@link defaultRegistry} — in-memory Map ops
 * - {@link routeFetchContext}, {@link scoreTool}, {@link scoreSnippet},
 *   {@link tokenize} — pure string functions used by both verbs
 * - All types
 *
 * Consumers targeting a browser context can use this surface to register
 * their own async-invoke tools against the registry and route queries to
 * them via `findTools`. A future browser-safe primitive (e.g. `searchWeb`
 * over `fetch`) would also land here.
 *
 * The `browser` export condition in `package.json` routes bundlers to this
 * entry automatically so downstream consumers never need to reach into
 * `src/` or author a shim. Keep this surface narrow; broaden only when a
 * browser consumer concretely needs another symbol.
 */

export { findTools } from "./find-tools.ts";
export { createRegistry, defaultRegistry } from "./registry.ts";
export { routeFetchContext, scoreSnippet, scoreTool, tokenize } from "./router.ts";
export type {
  Confidence,
  FetchContextHint,
  FetchContextOptions,
  FetchContextResult,
  FindToolsOptions,
  Snippet,
  Source,
  SourceType,
  ToolDefinition,
  ToolRegistry,
} from "./types.ts";
