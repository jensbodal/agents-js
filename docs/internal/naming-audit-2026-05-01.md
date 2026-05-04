# Naming & Description Audit — 2026-05-01

Wave-1 #9, research-only. Surveys every `packages/*` and `apps/*` for
description accuracy, generic-named utility files, suspect class suffixes,
and the browser-entry convention.

Resolution note: this document is the original audit snapshot from Wave 1.
The integration branch promotes Plane and Matrix out of `@agents-js/extras`,
continues decomposing `@agents-js/gateway-runtime`, and handles the actionable
Wave-2 items in follow-up commits. Treat the tables below as audit evidence,
not as current package topology after the local merge.

## Package descriptions

| Package | Current description | Issue | Suggested description |
|---------|---------------------|-------|------------------------|
| `a2a` | "A2A server — wraps an ACP agent as an HTTP JSON-RPC + SSE streaming endpoint with CORS support." | Accurate. | (no change) |
| `a2a-client` | "Reusable A2A client library for agents-js." | Vague — does not mention the AG-UI transport adapters, registry/sync, target discovery, or session view-model that dominate `src/`. | "A2A client: HTTP/SSE transport, AG-UI adapter, target registry, session view-model, and discovery for agents-js consumers." |
| `a2ui-host` | "Browser-side A2UI v0.9 host and bridge for agents-js." | Accurate; `src/` is `host.ts` + `bridge.ts`. | (no change) |
| `a2ui-renderer` | "Maps A2UI component trees onto the acp-* Lit primitives shipped by agents-js." | Accurate (acp-bindings.ts, dispatch.ts, surface-view.ts). | (no change) |
| `a2ui-types` | "Thin re-export layer over @a2ui/web_core v0.9 plus a custom catalog for agents-js." | Accurate. | (no change) |
| `acp` | "Low-level ACP client — spawns an agent process, communicates over stdio/NDJSON, and manages the ACP protocol lifecycle." | Accurate; covers `connection.ts`, `controller.ts`, `resilience.ts`. | (no change) |
| `acp-host` | "Stateful ACP host embedding surface. Manages agent sessions, terminal processes, permissions, and file I/O for host applications." | Accurate; the `session-*` set, `terminal-manager.ts`, `permission-engine.ts`, `node-file-adapters.ts` all match. | (no change) |
| `a2ui-acp-host-adapter` | "A2UI surface integration for @agents-js/acp-host — bridges ACP tool-call content into the A2UI renderer lifecycle." | Accurate. | (no change) |
| `agui-types` | "Thin wrapper around @ag-ui/core for the agents-js monorepo." | Accurate but understates: ships AG-UI adapters (base, custom, message, reasoning, run, tool-call) and `stream.ts`. | "AG-UI core re-exports plus first-party adapter set (message, reasoning, run, tool-call) and stream helpers for the agents-js monorepo." |
| `browser-runtime` | "Browser-native runtime for the docs meta-agent: WebLLM worker, JSON action loop, ACP shim" | Accurate; `webllm-worker.ts`, `meta-agent-loop.ts`, `browser-acp-shim.ts`, `action-schema.ts` all line up. | (no change — period missing for style consistency) |
| `cli` | "Terminal TUI and server commands for agents-js. Provides the agents-js binary with serve, client, and acp subcommands." | Accurate; `serve.ts`, `client/`, `acp.ts`, `bridge.ts`, `mcp.ts`, `send.ts` all present. | (no change, though `mcp` and `bridge` subcommands are not mentioned and exist in `src/`.) Optional: "...with serve, client, acp, bridge, mcp, and send subcommands." |
| `droid-acp` | "In-repo ACP adapter for Factory.ai's Droid CLI. Wraps per-turn `droid exec --output-format stream-json` invocations as an ACP AgentSideConnection over stdio." | Accurate. | (no change) |
| `editor-utils` | "Editor-oriented utilities for agents-js: mention parsing, inline context building, and markdown frontmatter helpers." | Accurate; matches `mention-parser.ts` + `frontmatter.ts`. | (no change) |
| `extras` | "Holding pen for provider/adapter/service code that does not belong in the protocol-level packages: Plane webhook, Matrix transport, Agent Zero adapter polyfill, and reference examples..." | Accurate; intentionally describes an in-flux package. | (no change) |
| `gateway-runtime` | "Gateway runtime wiring for agents-js: shared config, env parsing, and runtime-install descriptors used by the A2A gateway and apps." | Mostly accurate but understates: also handles runtime detection (`runtimes.ts`), env-overrides, sub-session spawn, and shared runtime-helpers used by host-executor. | "Gateway runtime: shared config, env parsing, runtime registry/detection, runtime-install descriptors, and sub-session spawn helpers used by the A2A gateway and apps." |
| `mcp-bridge` | "MCP server that exposes A2A agents as MCP tools. Each configured agent becomes a callable tool." | Accurate. | (no change) |
| `mock-acp` | "Deterministic mock ACP runtime for CI. Speaks the ACP stdio wire protocol and responds with canned replies. Not for production use." | Accurate; package only contains `index.ts` + `constants.ts`, so the description is unusually rich relative to surface — fine. | (no change) |
| `pi-acp` | "In-repo ACP adapter for Mario Zechner's Pi coding agent (@mariozechner/pi-coding-agent). Wraps the native 'pi --mode rpc' NDJSON stream as an ACP AgentSideConnection." | Accurate. | (no change) |
| `pi-extension` | "Pi CLI extension for A2A agent communication." | Vague. `src/` shows MCP client, direct client, bridge, and a node-entry — i.e. a Pi-side bridge that fans out to A2A targets. | "Pi CLI extension that bridges Pi tool-calls to A2A agents over MCP or direct A2A transport." |
| `policy` | "Stateless permission policy evaluation for ACP hosts. Pure functions with no framework dependencies." | Accurate. | (no change) |
| `profiles` | "Profile-based workspace isolation for ACP runtimes. Provides XDG env-var redirects into per-profile sandbox directories so multiple runtimes (or multiple operator personas) can coexist without sharing config / state." | Accurate. | (no change) |
| `reporting` | "Deterministic code-review reporting. Generates structured findings as markdown and JSON Canvas output." | Mostly accurate; understates the `orchestrator.ts` + worker fan-out pipeline (`workers.ts`, `runtime.ts`, `merge.ts`, `snapshot.ts`). | "Deterministic code-review reporting: orchestrates worker envelopes and emits merged findings as markdown and JSON Canvas output." |
| `schema-utils` | "Shared schema property parsing for ACP elicitation forms. Extracts field metadata from JSON Schema-like property definitions." | Accurate; `field-meta.ts` is the bulk of the surface. | (no change) |
| `skills` | "TypeScript-native skill loading, validation, and in-memory registry for SKILL.md-formatted skills. Pure, filesystem-only, no network or persistence." | Accurate; matches `core/`, `runtime/`, `registry/`, `conformance/`. | (no change) |
| `tools` | "Unified tool surface for agents-js: fetchContext coordinator (Shape 1) + findTools discovery surface (Shape 2). Single package for memory recall and tool discovery with a shared provenance schema." | Accurate. | (no change) |
| `trial-agent` | "Real-ACP isolation harness for @agents-js/tools..." | Accurate. | (no change) |
| `ui-components` | "Lit web components for ACP-aware chat interfaces. Drop-in surface with streaming, permissions, elicitation, auth, and theming." | Accurate; the `acp-*` component set covers all five. | (no change) |
| `validation` | "Schema validation for ACP envelopes, A2A requests/responses, runtime manifests, and JSON-RPC messages." | Accurate; the file set lines up with the listed surfaces (`acp.ts`, `a2a.ts`, `agui.ts`, `a2ui.ts`, `runtime.ts`, `cli.ts`, `json-rpc.ts`, `json-schema.ts`). | (no change) |
| `apps/internal-gateway` (`@agents-js/gateway`) | **MISSING** | No `description` field. | "Reference internal A2A gateway: hosts ACP runtimes, exposes AG-UI + WebSocket bridges, and serves a discovery endpoint." |
| `apps/web-ui` (`@agents-js/web-ui`) | **MISSING** | No `description` field. | "Reference Vite/Lit web UI consuming `@agents-js/ui-components` against a local internal-gateway." |

**Issue counts:**
- Missing description: **2** (both apps).
- Description vague / understates the code: **5** (`a2a-client`, `agui-types`, `gateway-runtime`, `pi-extension`, `reporting`).
- Description accurately reflects code: **23**.

## Internal "utils" / "helpers" smell

No `utils.ts`, `helpers.ts`, `common.ts`, `misc.ts`, or `lib.ts` was found
under any `packages/*/src/` or `apps/*/src/`. No `utils/`, `helpers/`,
`common/`, `lib/`, or `misc/` directories were found under `src/` either.

The only matches anywhere in the workspace are:

1. `packages/extras/tests/helpers.ts` — `TEST_PLANE_SECRET`,
   `TEST_PLANE_WEBHOOK_URL`, `signPlaneBody`, `buildPlaneRequest`. Plane
   webhook test fixtures. Recommendation: **rename to
   `plane-test-fixtures.ts`** so the file name matches what's inside; the
   "helpers" label is the only generic name in the file's neighborhood.
2. `extras/reporting/tests/helpers.ts` — `MockDepsOptions`,
   `createMockDeps`, `buildEnvelope`. Reporting test mocks/builders.
   Recommendation: **rename to `mock-deps.ts`** (or split into
   `mock-deps.ts` + `envelope-fixtures.ts`).
3. `packages/cli/src/cli-utils.ts` — argv-parsing primitives
   (`parseRuntimeLogLevel`, `consumeValue`, `parsePort`, `normalizeHost`,
   `VALID_RUNTIME_LOG_LEVELS`). Despite the `-utils` suffix, the file
   docstring already calls itself "argv-parsing + value-normalization
   helpers". The name `cli-utils.ts` is acceptable but
   **`argv-parsing.ts` would describe the contents more precisely** —
   `argv-parser.ts` already exists in the same directory and covers the
   higher-level command parser, so a rename to `argv-helpers.ts` would
   collide stylistically; pick one of `argv-parsing.ts` or
   `value-normalization.ts`.
4. `packages/acp/src/stream-utils.ts` — `ErrorSignal`,
   `ErrorAwareStreamOptions`, `createErrorAwareReadable`. Single concept:
   error-aware ReadableStream construction. Recommendation: **rename to
   `error-aware-stream.ts`**. The current `stream-utils.ts` understates
   that the file ships exactly one first-class abstraction.
5. `packages/gateway-runtime/src/shared-runtime-helpers.ts` —
   `RuntimeSelectionArgs`, `ProfileLookupContext`,
   `parseCustomArgsJson`, `createRuntimeSelectionFromArgs`,
   `getConfiguredProfile`. This file *is* a shared helper module for
   runtime selection, but the name leaks the "shared" coordination
   concern. Recommendation: **rename to `runtime-selection.ts`** —
   matches `runtime-env-overrides.ts`/`resolve-and-apply.ts` siblings.
6. `apps/internal-gateway/error-utils.ts` — single export
   `describeGatewayError`. Recommendation: **rename to
   `describe-gateway-error.ts`** or merge into a small
   `gateway-errors.ts` if more error helpers are imminent.

## *Manager / *Handler classes worth renaming

Repo-wide search across `packages/*/src` and `apps/*/src` found exactly
three classes ending in `Manager`, `Handler`, `Helper`, `Service`, `Util`,
or `Wrapper`. None ends in `Helper`/`Service`/`Util`/`Wrapper`.

1. `packages/a2a/src/persistence.ts:4` — `SessionIdStore`. Reads/writes
   one JSON file (`_dot/a2a-sessions.json`) holding a context-id ↔
   session-id `Map`. Two methods: `save`, `load`. **Resolved:
   `SessionIdStore`**. The class manages no
   lifecycle beyond a single file's serialize/deserialize, so "Store" is
   more honest than "Manager".
2. `packages/acp-host/src/terminal-manager.ts:108` — `TerminalManager`.
   Spawns child processes, tracks them in a `Map<string, ManagedTerminal>`,
   exposes `create`, `kill`, plus output-buffer management and
   exit-promise plumbing. The name **is** accurate here: this class owns
   the lifecycle of multiple terminals. **No rename recommended.**
3. `packages/ui-components/src/acp-chat-app-profiles.ts:41` —
   `ChatAppProfileManager`. Holds an in-memory copy of the connect-profile
   list, syncs to/from `localStorage`, and applies preferences via
   callback hooks. It is more "coordinator + persistence" than "manager",
   but the alternatives (`ProfileController`, `ProfileStore`) fit a Lit
   element's controller idiom. **Optional rename: `ProfileController`**
   to align with Lit's reactive-controller naming, since the class is
   constructed by an `acp-chat-app` element and forwards lifecycle calls.

Files named `*-handler.ts` exist (`packages/acp-host/src/terminal-handlers.ts`,
`packages/a2ui-acp-host-adapter/src/tool-call-content-handler.ts`) but they
**only export factories/interfaces, not classes** — both produce object
literals (`createTerminalHandlers`, `createA2uiToolCallContentHandler`)
and the `Handler` suffix here describes the JSON-RPC handler-set role
(matches the ACP spec's `terminalHandlers` shape), so it is
load-bearing rather than incidental. No rename recommended.

## Browser entry points

| Package | File | Exports | Doc'd convention? |
|---------|------|---------|-------------------|
| `acp-host` | `src/browser.ts` | `DEFAULT_AGENT_CONFIG`, `DEV_AGENT_CONFIG`, `Logger`, workflow-surface helpers. Long file-level comment justifies each entry. | Convention is documented **inline in the file's JSDoc**, not in any central doc. |
| `editor-utils` | `src/browser.ts` | Identical surface to main entry (pure TS); explains that `browser` condition exists to give bundlers a hand-off. | Inline JSDoc only. |
| `gateway-runtime` | `src/browser.ts` | Empty frozen `DEFAULT_EXTRA_BIN_PATHS`. Stub-with-empty-values discipline documented. | Inline JSDoc only. |
| `policy` | `src/browser.ts` | `classifyOperation`, `createPermissionRule`, `extractResourceScope`, `generateScopeCandidates` from `permission-engine.ts`. | Inline JSDoc only. |
| `tools` | `src/browser.ts` | `findTools`, `createRegistry`, `defaultRegistry`, `routeFetchContext`, `scoreTool`, `scoreSnippet`, `tokenize`, plus types. | Inline JSDoc only. |
| `trial-agent` | `src/browser.ts` | Throws `Error("@agents-js/trial-agent is a Node/Bun stdio ACP server and cannot run in a browser...")` at module load. Intentional bundler-fail-loud. | Inline JSDoc only. |
| `browser-runtime` | _entire package_ | Whole package is browser-native; no separate `browser.ts` needed. | n/a |
| `acp-host/src/browser-acp-shim.ts` | (note) The shim under `browser-runtime/src/`, not a package entry | n/a — not a `browser` export-condition entry. | n/a |

**The browser-safe convention is not codified anywhere centrally.** The
task brief mentioned `_dot/README.md`, which does not exist in this
repo. Each browser entry's JSDoc independently restates the discipline:

- the `browser` package.json export-condition routes bundlers to it,
- browser callers should not reach into `src/` directly,
- prefer empty/frozen stub values over `throw` so bundle-time imports
  don't crash test harnesses (with `trial-agent` as the deliberate
  exception that throws because the entire package is server-only),
- expand only when a downstream consumer concretely needs a new symbol.

**Recommendation:** Hoist this convention into a top-level doc such as
`docs/develop/browser-entry-points.md` (or `AGENTS.md`) so reviewers
have one place to point at when a new package needs a browser entry. The
six files agree but currently re-derive the policy independently.

## Possibly-unused files

Spot-checked imports for every "single-file directory" found under `src/`:

| Path | Imports verified |
|------|------------------|
| `packages/a2a-client/src/adapters/target.ts` | Imported by `packages/a2a-client/src/index.ts` and a test. **Used.** |
| `packages/acp-host/src/testing/mock-acp-agent.ts` | Imported by `packages/acp-host/src/testing.ts` (barrel) and four test files. **Used.** Note: `testing.ts` is a one-line re-export of the only file inside `testing/`; this is the leanest possible shape and is fine — flagged here only for the reviewer's attention. |
| `packages/cli/src/client/command.ts` | (not import-checked in this audit; please spot-check during review) |
| `packages/extras/src/adapters/agent-zero.ts` | Surfaced via `extras/package.json` `./adapters/agent-zero` export. **Used.** |
| `packages/extras/src/examples/a2a-client-local-source-consumer.ts` | **No `from` imports across the workspace.** This is a runnable example (`#!/usr/bin/env bun`, `import.meta.main` self-invocation referenced in its README/run instructions). It is **not** unused, but it is **not exported** from `extras/package.json` either — the file documents itself in a doc-string string literal. Recommendation: either add an `./examples/a2a-client-local-source-consumer` export to `extras/package.json` (so consumers can run it via the package), or move it under `examples/` at the repo root (out of `src/`), or note the executable-script status in `extras`'s description. As shipped, a TS bundler scanning `src/` will compile it as a regular module. |
| `packages/skills/src/conformance/strict.ts` | Imported by `packages/skills/src/index.ts`. **Used.** |
| `packages/skills/src/registry/in-memory.ts` | Imported by `packages/skills/src/index.ts`. **Used.** |
| `packages/validation/src/generated/acp-schema.ts` | Generated artifact (its directory is named `generated/`). Used by other validation modules (per file naming). **Generated/used.** |

**Files that exist but appear not to be imported anywhere (zero
`from "..."` matches):**

- `packages/extras/src/examples/a2a-client-local-source-consumer.ts` —
  see note above; not strictly unused, but not a normal package export
  either. Worth deciding whether `examples/` belongs under `src/` at all
  (compare `apps/` for runnable code, `src/` for library code).

No other zero-import files were found within the spot-check window. A
deeper `ts-prune` / `knip` pass is out of scope for this audit; the
above list is what surfaced from manual single-file-dir review plus
import grepping.

## Summary

- **App descriptions are missing.** `apps/internal-gateway` and
  `apps/web-ui` both omit `description` from their `package.json`.
  Highest-leverage fix in this audit.
- **Five package descriptions understate their `src/`.** `a2a-client`,
  `agui-types`, `gateway-runtime`, `pi-extension`, and `reporting` each
  ship more surface than the description advertises (adapters, AG-UI
  wiring, runtime registry, MCP/direct bridges, worker orchestration).
  Tighten copy so `npm view <pkg>` answers what the code does.
- **No `utils.ts` / `helpers.ts` smells inside any package's `src/`.**
  The cross-package discipline already pays off — only six rename
  candidates exist, all minor (test fixtures, one CLI argv module, one
  acp stream helper, one gateway-runtime helper, and one app-level
  `error-utils.ts`).
- **Manager-class smell is contained to three classes.**
  `SessionIdStore` resolved the only clear over-promise. `TerminalManager` is honest. `ChatAppProfileManager`
  is borderline; rename to `ProfileController` only if Lit reactive-
  controller alignment is desirable.
- **Browser-entry convention is consistent across six packages but
  un-codified.** Lifting the per-file JSDoc into a single
  `docs/develop/browser-entry-points.md` would give the convention a
  single point of truth and stop new packages from re-deriving it.
