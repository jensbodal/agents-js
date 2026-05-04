---
title: Primitives
---

# Primitives

> **Status:** Beta · **Validated by:** package tests, `bun run check`, `docs:build` drift gates · **Known limitations:** see per-page status badges + [Streaming and Events → Deliberate limits](/streaming-and-events#deliberate-limits)

agents-js is not a framework. It is a set of **composable primitives** — small,
focused packages that each do one thing well. Wire them together and you get a
gateway, a browser client, or an IDE plugin. Use just one and you get a
validation layer, a permission engine, or a mention parser.

Every package falls into one of three roles — **Provider** (business logic),
**Transport** (protocol I/O), or **Adapter** (host callbacks) — and the
boundaries between them are defined by TypeScript interfaces, not concrete
classes. This is the Ports & Adapters (hexagonal) pattern.

## Overview

agents-js implements the ACP and A2A protocols. ACP gives you a local
session-oriented transport to an agent process (stdio/NDJSON). A2A gives you a
multi-conversation HTTP gateway that any remote client can call. The repo ships
both the client and server sides, plus the host-layer adapters that let a
consumer embed ACP sessions in any platform.

The architecture only makes sense if the standards stack is explicit:

| Standard / Schema | Repo role | What agents-js does |
|---------|----------|----------------|
| `JSON-RPC 2.0` | Envelope layer | Validates request/response envelopes and uses them under both ACP and A2A transports. |
| `ACP` | Direct implementation | Runs session lifecycle, prompts, cancels, session history, and host-mediated session updates over stdio/NDJSON. |
| `A2A` | Direct implementation | Exposes HTTP + SSE gateway behavior, agent-card discovery, streaming task updates, and client transport consumption. |
| `MCP` | Pass-through compatibility | Carries MCP server configuration through ACP session setup and preserves ACP content compatibility with MCP-style content blocks. |
| `AG-UI` | Semantic alignment | Shapes the repo's event vocabulary and client-side workflow semantics; not a wire-compatibility claim. |
| `A2UI` | Component vocabulary alignment | Shapes the standalone Lit component primitives and host vocabulary; not an agent-authored surface protocol in this repo. |
| `Runtime manifests` | Repo-defined validation surface | Validated by `@agents-js/validation`, with runtime-specific validators registered by the repo or consumers. |

See [Protocols & Schemas](/protocols) for the standards map and the
extension boundaries that sit above these layers.

## Layer Diagram

The cross-application picture has three layers. Each layer has one job and a
very small set of things it is allowed to touch.

For an interactive, pannable view of the host / gateway / agent layers and
the protocols that connect them, see [Architecture](./architecture). The
detailed responsibilities of each layer follow below.

### Host layer responsibilities

- Own the user-facing conversation (UI state, input rendering, scroll,
  session history).
- Run `beforePrompt` middleware that enriches the prompt with host-specific
  context: @mention expansion, vault file inlining, system prompts, audit
  headers.
- Enforce permissions — the host is the only layer that knows the user's
  consent state.
- Decide *what* prompt the downstream agent sees. By the time the prompt
  leaves the host, it is fully formed and does not need further rewriting.

### Gateway layer responsibilities

- Accept A2A requests.
- Maintain a pool of ACP sessions keyed by `contextId`. One session per
  conversation, created on first contact, reused on subsequent messages.
- Translate ACP session events into A2A `TaskStatusUpdateEvent`s and
  terminal `Task` objects.
- Do nothing else — no prompt mutation, no middleware, no policy enforcement
  beyond what the transport itself demands.

### Remote agent layer responsibilities

- Be an ACP process. That is the whole spec.
- Deliberately ignorant of A2A, mentions, hosts, and who is calling.

## Package Map

> All publishable packages ship on the same beta train. Bugs are bugs — they get fixed in the next patch. There is no separate tier split per package. See [Beta Contract](/beta-contract) for the canonical statement of what beta means.

| Layer | Package | What it does |
|-------|---------|--------------|
| **Core** | `@agents-js/policy` | Permission rules, write-gate evaluation, path utilities |
| **Core** | `@agents-js/validation` | Schema validation for ACP, A2A, runtime manifests, JSON-RPC |
| **Core** | `@agents-js/acp` | ACP client — spawn agent, stdio/NDJSON transport |
| **Core** | `@agents-js/acp-host` | Session orchestrator — permissions, terminals, hooks |
| **Core** | `@agents-js/a2ui-host/acp-host` | A2UI `HostSurfaceAdapter` + `SurfaceSession` wiring for the acp-host tool-call meta path |
| **Core** | `@agents-js/agui-types` | Canonical AG-UI types — re-exports `@ag-ui/core` (pinned pre-1.0) plus agents-js adapter helpers |
| **Core** | `@agents-js/a2ui-types` | Thin wrapper over `@a2ui/web_core` v0.9 — protocol surface, basic catalog, and the ACP custom catalog |
| **Core** | `@agents-js/droid-acp` | Factory.ai Droid CLI ACP runtime adapter |
| **Core** | `@agents-js/pi-acp` | Pi ACP runtime adapter |
| **Protocol** | `@agents-js/a2a` | A2A server — HTTP JSON-RPC + SSE streaming endpoint |
| **Protocol** | `@agents-js/a2a-client` | A2A client — browser-compatible, state-driven controller |
| **Protocol** | `@agents-js/mcp-bridge` | MCP server exposing A2A agents as MCP tools |
| **Protocol** | `@agents-js/gateway-runtime` | Shared gateway runtime catalog, profile isolation, env resolution, and install-hint helpers |
| **Utility** | `@agents-js/schema-utils` | Schema property parsing for ACP elicitation forms |
| **Utility** | `@agents-js/acp-host/editor` | Mention parser, frontmatter extraction |
| **Utility** | `@agents-js/skills` | Skill loading and management primitives |
| **Utility** | `@agents-js/tools` | Coordinator + discovery surface — `fetchContext`, `findTools`, `SpawnAgent`, sigil registry |
| **Surface** | `@agents-js/cli` | Terminal TUI — `serve`, `bridge`, `client`, `send`, `acp`, `mcp`, `registry` commands |
| **Surface** | `@agents-js/ui-components` | Lit web components — chat, transcript, elicitation, theming |
| **Surface** | `@agents-js/a2ui-host` | DOM-side A2UI host + bridge — one `MessageProcessor` per mount, hot-reload-safe attach/detach |
| **Surface** | `@agents-js/a2ui-renderer` | Maps A2UI component trees onto the `acp-*` Lit primitives in `@agents-js/ui-components` |
| **Surface** | `@agents-js/reporting` | Code-review reporting — markdown and JSON Canvas output |
| **Surface** | `@agents-js/pi-extension` | Pi CLI extension — registers A2A agents as Pi tools via MCP bridge or in-process `a2a-client` |

## Ports & Adapters

### Provider — Business Logic Facade

A Provider owns session state, orchestrates multi-step flows (turns, streaming,
elicitation, auth), and emits events to subscribers. It never touches the
network or the host platform directly.

| Package | Provider | Responsibility |
|---------|----------|----------------|
| `a2a-client` | `A2AClientProvider` | Observable turn execution over A2A. Normalizes immediate messages, streamed tasks, and resumable continuations. Emits `A2AEvent` to listeners. |
| `acp` | `ACPClientController` | ACP session lifecycle: initialize, new/load session, prompt, cancel, dispose. Emits `ACPControllerEvent` to listeners. |
| `acp-host` | `ACPSessionController` | High-level session orchestrator: spawn agent, manage permissions, terminals, write gates, prompt queue, mode switching. Emits `ACPSessionEvent` to listeners. |

### Transport — Protocol I/O

A Transport handles wire protocol details: HTTP, SSE, stdio, NDJSON,
target resolution, streaming envelope unwrapping. It implements an interface
and is injected into a Provider.

| Package | Transport | Responsibility |
|---------|-----------|----------------|
| `a2a-client` | `SdkA2ATransport` (implements `A2ATransport`) | Resolves agent cards, sends messages, streams events over HTTP/SSE via the A2A SDK. |
| `acp` | `ClientSideConnection` + stdio/NDJSON | Bidirectional JSON-RPC over stdin/stdout to a spawned agent process. |
| `a2a` | `UniversalA2AServer` | Inbound HTTP server: receives JSON-RPC + SSE requests, routes to an executor, validates envelopes. |

### Adapter — Host Platform Callbacks

An Adapter is a set of callbacks that the host platform injects at session
creation time. Adapters let the framework delegate decisions (permissions,
file I/O, terminal management, elicitation UI) to whatever host is running.

| Package | Adapter | Responsibility |
|---------|---------|----------------|
| `acp` | `ACPHostAdapters` | Permission requests, session updates, elicitation, file read/write, terminal lifecycle. |
| `acp-host` | `HostFileAdapters` | File read/write with write-gate approval callback. |
| `acp-host` | `HostElicitationAdapter` | Form-based elicitation requests from the agent. |
| `acp-host` | `DependencyRegistry` | Capability discovery: query what host integrations are available. |

### Dependency layers

```
Layer 0 (Leaf):    policy, schema-utils, reporting
Layer 1:           ui-components (-> schema-utils), validation (-> policy)
Layer 2:           acp (-> policy), acp-host (-> policy, acp, validation)
Layer 3:           a2a (-> acp, policy, validation), a2a-client (-> validation)
Layer 4:           cli (-> a2a-client, acp, acp-host, a2a, schema-utils),
                   gateway-runtime (-> a2a, acp-host)
Apps:              internal-gateway (-> acp, acp-host, a2a, cli)
                   web-ui (-> a2a-client, ui-components)
```

Leaf packages have zero internal dependencies and can be used standalone.
Each layer only depends on packages in lower layers, never on peers or
packages above it.

### Key interfaces

| Interface | Package | File | Role |
|-----------|---------|------|------|
| `A2ATransport` | `a2a-client` | `src/types.ts` | Transport contract for A2A protocol I/O |
| `ACPHostAdapters` | `acp` | `src/controller.ts` | Adapter contract for ACP host callbacks |
| `HostFileAdapters` | `acp-host` | `src/types/adapters.ts` | File I/O with write-gate approval |
| `HostElicitationAdapter` | `acp-host` | `src/types/adapters.ts` | Agent-driven form elicitation |
| `DependencyRegistry` | `acp-host` | `src/types/host-adapters.ts` | Runtime capability discovery |
| `ACPClientState` | `acp` | `src/controller.ts` | ACP connection state machine |
| `A2ASessionState` | `a2a-client` | `src/types.ts` | A2A session state snapshot |
| `ACPSessionState` | `acp-host` | `src/types/session.ts` | Full host session state |
| `StartConfig` | `acp-host` | `src/types/adapters.ts` | Session controller configuration |

## Tool Surface — `@agents-js/tools`

`@agents-js/tools` consolidates three agent-facing verbs behind one package:

- **`fetchContext(query, options?)`** — a **coordinator** that picks memory
  primitives based on query shape, runs them, and returns a ranked set of
  snippets with a canonical provenance record. Agents call this when they
  need grounded prior state before answering.
- **`findTools(query, options?)`** — a **discovery surface** that returns
  1–3 matching tools from an in-memory registry, so agents see a narrow
  relevant subset rather than a full wall-of-tool-JSON per prompt.
- **`spawnAgent(subtask, options?)`** — a **subagent dispatch** that hands a
  bounded subtask off to a fresh ACP session under the configured harness,
  waits for the terminal summary, and returns it with tool-level provenance.
  The current implementation supports bounded mode against the trial-agent
  harness.

Every source returned by `fetchContext` carries the same five-field
provenance schema:

| field | meaning |
|---|---|
| `source_type` | `matrix` \| `hub-file` \| `agent-msg` \| `cognee` \| `web` \| `tool` |
| `source_ref` | stable identifier (path, event ID, mailbox ID, URL, tool name) |
| `observed_at` | ISO 8601 — when the source was originally observed |
| `retrieved_at` | ISO 8601 — when this query read it |
| `confidence` | `responsible` (canonical) vs `supporting` (corroborating) |

`searchMemories` reads `.agents/<name>/*.md`; `searchDocs` performs a
grep-based search over the configured docs root. Both auto-register as tools
in the default registry. Calling `findTools("search docs for X")` returns
`searchDocs` without additional wiring.

### Usage

```ts
import { fetchContext, findTools, spawnAgent } from "@agents-js/tools";

const ctx = await fetchContext("what rule was recorded about commits?", {
  workspaceRoot: process.cwd(),
});
for (const snippet of ctx.snippets) {
  const src = ctx.sources[snippet.source_index];
  if (src) console.log(snippet.text, "←", src.source_ref, src.confidence);
}

const tools = await findTools("search docs for ACP schema notes");
for (const tool of tools) console.log(tool.name, tool.description);

const result = await spawnAgent("summarize the ACP schema notes", {
  hints: { harness: "trial" },
  timeout_ms: 30_000,
});
console.log(result.status, result.summary, result.sources);
```
