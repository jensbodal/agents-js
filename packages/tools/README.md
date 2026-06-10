# @agents-js/tools

> Unified tool surface for agents-js: fetchContext coordinator (Shape 1) + findTools discovery surface (Shape 2). Single package for memory recall and tool discovery with a shared provenance schema.

## Installation

```sh
bun add @agents-js/tools
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`SigilResolutionError`** — Thrown when `resolve` is called for a `SigilKind` that has no registered resolver and every applicable resolver has returned `UNHANDLED`. `code` follows the `"tools/<slug>"` convention from the res...
- **`SpawnAgentInvalidInputError`** — Structured error thrown when a caller passes invalid input to {spawnAgent}. Separate from the result-shape failure modes (`harness_unavailable`, `depth_limit_exceeded`, etc.) because invalid input ...
- **`TraceEmitter`** — Construct a {ToolCallTrace} and forward to the configured sink. Callers typically don't use this directly — prefer {wrapToolWithTrace} or {TraceEmitter.record} around an arbitrary async call.

### Functions

- **`applyRedaction`** — Apply a top-level redaction spec to an object. Returns a shallow copy with listed keys replaced by {REDACTION_SENTINEL}. Non-object inputs pass through unchanged (no way to redact a scalar by key)....
- **`createJsonlFileSink`** — Append-only JSONL sink. Each `emit` writes a single line (JSON.stringify(record) + "\n") to the given path, creating the parent directory if missing. Writes are serialized through a per-sink promis...
- **`createMemorySink`** — In-memory sink. Retains every emitted record on a `records` array. Primarily for tests.
- **`createNoopSink`** — No-op sink. Useful as an explicit default when trace infrastructure is wired but emission should be disabled (e.g. in production prior to a retention policy landing).
- **`createRegistry`** — Create a fresh, isolated in-memory {ToolRegistry}. The module-level {defaultRegistry} is populated at load time with the two memory primitives. Callers that want isolation (tests, per-agent scopes,...
- **`createSigilRegistry`** — Create a fresh, isolated {SigilRegistry}. The returned registry has the built-in `!command` fallback (which always returns `UNHANDLED`) pre-registered so the `"bang"` kind is always in the chain. H...
- **`fetchContext`** — Grounded memory-recall coordinator (Shape 1). Picks memory primitives based on query-shape heuristics, runs them (in parallel when the router picks `"both"`), merges their `FetchContextResult` outp...
- **`findTools`** — Narrow tool-discovery surface (Shape 2). Returns up to `limit` tools (default 3) from an in-memory registry, ranked by keyword overlap against each tool's name, keywords, and description via the sh...
- **`parseSigil`** — Parse a raw input string into a {Sigil}. Returns `null` when the input does not start with a recognised sigil prefix (after optional leading whitespace). The prefix must be immediately followed by ...
- **`registerBuiltins`** — Register the three built-in primitives into the default registry. Idempotent: registering the same name twice overwrites the prior entry, so callers may safely invoke this from any bootstrap path. ...
- **`resolveSigil`** — Convenience wrapper: parse `input` and dispatch via `registry.resolve`. Equivalent to `registry.resolve(input, context)` — provided so callers that hold both a registry and a raw string do not need...
- **`routeFetchContext`** — Pick a routing hint based on query-shape heuristics. Explicit `hint` passed by the caller always wins.
- **`safeSerializeRecord`** — Serialize a `ToolCallTrace` record with a fallback for values that `JSON.stringify` rejects (functions, circular refs, BigInt, Symbol, etc.). The first attempt uses the native serializer; on failur...
- **`scoreSnippet`** — Lightweight keyword-score for snippet ranking. Counts how many query tokens appear in `text`. Case-insensitive; no stemming.
- **`scoreTool`** — Score a tool against a query. Higher score = better match. 0 means no match and the tool should be filtered out by the registry. Scoring: +2 per keyword hit, +1 per description token hit, +3 if the...
- **`searchDocs`** — Grep-style search across markdown files under the given document root root, returning the best-matching line range from each file. Skips `node_modules`, `.git`, `.obsidian`, `.trash`, `dist`, `out`...
- **`searchMemories`** — Search markdown memory files under `.agents/<name>/` inside the given workspace root and return the best-matching line range from each file. Every returned source is `source_type: "hub-file"` with ...
- **`spawnAgent`** — Spawn a subagent, run the subtask, return the terminal summary with tool-layer provenance. See module docstring for scope. The call is purely a wrapper over {spawnSubSession} — all process spawn / ...
- **`tokenize`** — Split on whitespace and non-word chars; lowercase; drop short tokens.
- **`translateGatewayResult`** — Convert a gateway {SpawnSubSessionResult} into a tool-layer {SpawnAgentResult} by attaching provenance. Exposed for tests that want to assert on the mapping without spawning anything.
- **`validateCompositionId`** — Validate a composition-chain id (parent or root event id). Accepts: - `null` / `undefined` — legitimate "no parent / no root override" - ULID or UUID v4 matching {COMPOSITION_ID_PATTERN} Invalid sh...
- **`wrapToolWithTrace`** — Return a new {ToolDefinition} whose `invoke` records a trace record on every call. The returned tool retains the original name, description, keywords, and redaction spec — drop-in replacement. The ...

### Interfaces

- **`FetchContextOptions`** — Options for `fetchContext`. `workspaceRoot` / `hubRoot` exist so tests can point primitives at fixture directories without monkey-patching cwd.
- **`FetchContextResult`** — Result of a `fetchContext` call.
- **`FindToolsOptions`** — Options for `findTools`.
- **`HandledResult`** — Successful resolution result. `value` is opaque at the registry layer; the resolver and its caller agree on the shape.
- **`RedactionSpec`** — Per-tool redaction spec. Applied by the trace emitter before persistence so secret fields never land in the append-only log. See `tool-call-trace-schema-2026-04-21.md` §3 for design rationale. The ...
- **`SearchDocsOptions`**
- **`SearchMemoriesOptions`**
- **`Sigil`** — A parsed sigil: its category (`kind`) and the bare token after the prefix (`name`). Trailing arguments are NOT part of the sigil; they belong in `SigilContext.args`. Example: `$skill run-docs arg1`...
- **`SigilContext`** — Runtime context forwarded to every resolver invocation. `args` carries whitespace-split tokens that follow the sigil name in the original input string. Resolvers may inspect or forward them as need...
- **`SigilRegistry`** — Registry surface for sigil resolvers. Use {createSigilRegistry} to obtain an isolated instance.
- **`Snippet`** — A snippet of matched text from a source, carrying a back-index into `sources` and a relevance score (0..n, higher = better).
- **`Source`** — Canonical 5-field provenance record. Every result must populate all five. `observed_at` is the source-side observation timestamp (file mtime, Matrix event origin, agent-msg created_at, etc). `retri...
- **`SpawnAgentOptions`** — Input shape. `subtask` is positional. Every other field is optional and carries a sensible default. `parent_session_id` is carried so trace / audit records can correlate to the spawning session; v1...
- **`SpawnAgentResult`** — Result of a tool-layer spawn. Mirrors the gateway result with provenance (`sources`) added and status widened to include `"depth_limit_exceeded"`.
- **`ToolCallTrace`** — Single tool invocation event. Mirrors the JSON shape defined in the schema spec. `result` is optional because not every terminal record carries a success payload (error cases may have `null`); `arg...
- **`ToolDefinition`** — Contract for a single tool in the Shape 2 registry. `keywords` bias the router; they do not need to be exhaustive because `description` is also scored. `invoke` is deliberately `unknown` in + out: ...
- **`ToolRegistry`** — In-memory registry surface. The default module-level registry populates at load time with the two memory primitives; callers may instantiate an isolated registry via {createRegistry}.
- **`TraceEmitterOptions`** — Construction options for {TraceEmitter}. Test seams for `now` and `generateEventId` exist so tests can produce deterministic records without monkey-patching globals.
- **`TraceInvocationContext`** — Context carried per-invocation into {TraceEmitter.record}.
- **`TraceSink`** — Destination for persisted trace records. Implementations must be idempotent with respect to concurrent writes — the emitter does not serialize calls.
- **`UnhandledResult`** — Sentinel returned when a resolver declines to handle a sigil, passing control to the next registered resolver for the same kind.

### Types

- **`Confidence`** — Confidence classification for a source. - `responsible` — the current, canonical source of truth for this datum. - `supporting` — corroborating context, may be stale or derivative. Callers that wan...
- **`FetchContextHint`** — Routing hint for `fetchContext`. `"both"` runs primitives in parallel and merges. Default routing picks a preference from query-shape heuristics.
- **`ResolverResult`** — Discriminated union of {HandledResult} and {UnhandledResult}.
- **`SigilKind`**
- **`SigilResolver`** — A function that attempts to resolve a parsed sigil in the given context. Returns {UNHANDLED} to pass control to the next resolver in the chain.
- **`SourceType`** — What kind of source a result came from. Kept narrow + explicit so the router + consumers can filter by source class without string parsing.
- **`SpawnAgentHints`** — Re-export gateway hints for tool-layer callers.
- **`SpawnAgentStatus`** — Terminal status of {spawnAgent}, including tool-layer-specific cases.

### Constants

- **`builtinCommandResolver`** — Built-in `!command` resolver. Always returns `UNHANDLED`. Hosts MUST register their own `"bang"` resolver that calls through `-js/policy`'s `validateTerminalRequest` before executing any shell comm...
- **`DEFAULT_FETCH_CONTEXT_HUB_ROOT`**
- **`defaultRegistry`** — Module-level registry. Populated lazily via {ensureDefaultPopulated} so primitive files can import the registry without triggering their own re-entry at import time.
- **`REDACTION_SENTINEL`** — Sentinel used to replace redacted field values.
- **`searchDocsTool`**
- **`searchMemoriesTool`**
- **`SPAWN_AGENT_DEFAULT_MAX_DEPTH`** — Default self-spawn depth cap. Configurable per-call.
- **`spawnAgentTool`**
- **`TOOL_CALL_TRACE_SCHEMA_VERSION`** — Current schema version emitted by this module.
- **`UNHANDLED`** — Sentinel constant. Resolvers should `return UNHANDLED` rather than constructing `{ status: "unhandled" }` inline — it is more readable and the reference equality makes test assertions straightforward.


## Dependencies

- `@agents-js/gateway-runtime`
- `@agents-js/shell-args`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
