# agents-js

**A TypeScript library tying together the latest versions of ACP, A2A, AG-UI, A2UI, and MCP — plus a CLI that wires them together.**

Full documentation: https://agents-js.bodal.dev/

## What it is

`agents-js` is a Bun + TypeScript workspace that implements the protocols used by modern coding agents and ships clients, servers, hosts, and surfaces for each one. It exposes ACP runtimes (claude, codex, opencode, droid, pi, ...) over A2A, lets A2A agents be consumed as MCP tools, and renders agent output through AG-UI / A2UI surfaces. The library is the foundation; the `agents-js` CLI is a single binary that wires the pieces together for everyday use.

Protocols this library implements or wraps:

- [ACP — Agent Client Protocol](https://agentclientprotocol.com/)
- [A2A — Agent-to-Agent](https://a2a-protocol.org/)
- [AG-UI](https://github.com/ag-ui-protocol/ag-ui)
- [A2UI](https://github.com/a2ui-protocol/a2ui)
- [MCP — Model Context Protocol](https://modelcontextprotocol.io/)

```
┌──────────┐  A2A   ┌──────────┐  A2A   ┌──────────┐
│ Obsidian │◄──────►│ gateway  │◄──────►│  Slack   │
│  agent   │        │ (claude) │        │  agent   │
└──────────┘        └────┬─────┘        └──────────┘
                         │ ACP
                    ┌────┴─────┐
                    │ Claude / │
                    │ OpenCode │
                    └──────────┘
```

## Quick Start

There are two paths through this repo. Pick the one that matches your goal.

### CLI users start here

Run any ACP coding agent as an A2A server, talk to it from a terminal, and bridge it into MCP hosts — without writing TypeScript.

**Install:**

```sh
# One-off, no install
bunx @agents-js/cli --help

# Or install globally
npm i -g @agents-js/cli
agents-js --help
# `ajs --help` works as a shorter alias for the same binary
```

**Five-line quick start:**

```sh
agents-js serve --harness claude               # spawn claude over A2A
agents-js client --url http://127.0.0.1:<port> # open the TUI
# or, one-shot:
agents-js send --url http://127.0.0.1:<port> "hello"
```

**Subcommands:**

| Command | One-liner |
| --- | --- |
| `agents-js serve` | Long-lived A2A gateway over a configured ACP runtime. |
| `agents-js bridge` | Ephemeral, no-config A2A gateway for a single curated harness. |
| `agents-js acp` | Pipe stdio between this process and a configured ACP runtime. |
| `agents-js mcp` | Stdio MCP server that exposes registered A2A agents as MCP tools. |
| `agents-js client` | A2A client TUI, one-shot message sender, or endpoint probe. |
| `agents-js send` | Headless one-shot prompt to a running gateway. |
| `agents-js registry` | Manage `~/.agents-js/registry.json` (A2A and ACP entries). |

Full flag and exit-code reference: [packages/cli/README.md](packages/cli/README.md).

### Library users start here

Install only the protocol packages you need:

```sh
bun add @agents-js/acp @agents-js/a2a @agents-js/a2a-client
```

Or, for host-side memory write surfaces (Bun runtime only):

```sh
bun add @agents-js/memory @agents-js/memory-local
```

Drive a running A2A gateway through `@agents-js/a2a-client` and read the result:

```ts
import { A2AClientController } from "@agents-js/a2a-client";

const controller = new A2AClientController();
await controller.connect({ url: "http://127.0.0.1:7878", mode: "base" });
await controller.sendTurn("Reply with the single word ready.");

const state = controller.getState();
const reply = [...state.transcript].reverse().find((entry) => entry.role === "agent");
console.log(reply?.text ?? null);
```

A complete runnable variant lives in [`examples/agent-zero/a2a-client-local-source-consumer.ts`](examples/agent-zero/a2a-client-local-source-consumer.ts), and an `AgentCard`-rewriting `TargetAdapter` example lives in [`examples/agent-zero/agent-zero.ts`](examples/agent-zero/agent-zero.ts).

Per-package READMEs document each surface in detail — see the table below.

## Routing between agents

Register agents in `~/.agents-js/registry.json`:

```json
{
  "agents": {
    "slack-agent": { "url": "http://localhost:3100" },
    "docs-agent": { "url": "http://localhost:3200" }
  }
}
```

Then use directives in any prompt sent through a host that wires them:

```
@@slack-agent post summary to #releases     # dispatch — entire message forwarded
@docs-agent what changed in v0.2?           # mention — inline agent reference
```

`@@dispatch` is part of direct-dispatch hosts such as the reference gateway and native Pi peer mode. Single-`@` mentions are a host opt-in middleware behavior — the checked-in gateway wires it by default, embedders opt in through `createA2AMentionMiddleware(...)`, and native Pi peer mode wires the same user-facing directives inside Pi.

## Bridging agents into MCP

Expose any registered A2A agent as an MCP tool for Claude Code, Cursor, or any MCP host:

```sh
agents-js mcp                  # start the stdio MCP server
agents-js mcp setup            # write .mcp.json in cwd
agents-js mcp setup --claude   # register via `claude mcp add`
```

## Permission mediation

Four modes control what the agent can do without asking — aligned with ACP / Claude Code vocabulary:

| Mode | Behavior |
|------|----------|
| `default` | Prompt before every gated action (reads auto-approve, writes prompt) |
| `acceptEdits` | Auto-approve edit operations without prompting |
| `plan` | Reads auto-approve, agent enters plan mode |
| `bypassPermissions` | Skip permission gating entirely (auto-approve all) |

Folder-scoped auto-approve (the legacy `hub` mode's documented intent) is independent of the mode flag — it's driven by the `hubPath` session field and the write-gate path check, so any mode can use it.

Legacy strings (`ask` / `yolo` / `hub`) are accepted by the WS bridge for one release cycle and normalized to the canonical vocab; they will be removed in the next breaking release.

## Architecture

Ports & Adapters. Every package fills one of these roles: **Provider** (business logic), **Transport** (protocol I/O), or **Adapter** (host callbacks).

See [Primitives](docs/primitives.md) for the full layer diagram.

## Packages

`Visibility` reflects the `private` field in each manifest: **public** packages are published and importable as `@agents-js/<name>`; **internal** packages exist only inside this workspace.

| Package | Layer | Visibility | One-liner |
|---------|-------|------------|-----------|
| `@agents-js/policy` | Core | public | Stateless permission rules and write-gate evaluation. |
| `@agents-js/validation` | Core | public | Schema validation for ACP, A2A, runtime manifests, and JSON-RPC. |
| `@agents-js/acp` | Core | public | Low-level ACP client — spawns the agent, talks stdio/NDJSON. |
| `@agents-js/acp-host` | Core | public | Stateful ACP host: sessions, terminals, permissions, file I/O. |
| `@agents-js/host` | Core | public | ACP host orchestration: sessions, executor, AGUI endpoint, WS bridge — extracted from internal-gateway. |
| `@agents-js/agui-types` | Core | public | AG-UI core re-exports plus first-party message/run helpers. |
| `@agents-js/a2ui-types` | Core | public | Thin wrapper over `@a2ui/web_core` v0.9 with the ACP custom catalog. |
| `@agents-js/schema-utils` | Core | public | Shared schema property parsing for ACP elicitation forms. |
| `@agents-js/skills` | Core | public | TypeScript-native skill loading, validation, and registry. |
| `@agents-js/memory` | Core | public | Write-side memory provider primitive — actor/scope/record types, conformance harness for backend implementations. |
| `@agents-js/memory-local` | Core | public | Reference memory provider — sqlite-backed (Bun runtime only), policy-gate seam, creator-only ACL. |
| `@agents-js/a2a` | Protocol | public | A2A server — wraps an ACP agent as HTTP JSON-RPC + SSE. |
| `@agents-js/a2a-client` | Protocol | public | Browser-compatible A2A client controller, AG-UI adapter, target registry. |
| `@agents-js/mcp-bridge` | Protocol | public | MCP server that exposes A2A agents as MCP tools. |
| `@agents-js/gateway-runtime` | Protocol | public | Runtime registry, env parsing, install descriptors, sub-session spawn helpers. |
| `@agents-js/cli` | Surface | public | The `agents-js` binary: `serve`, `bridge`, `acp`, `mcp`, `client`, `send`, `registry`. |
| `@agents-js/ui-components` | Surface | public | Lit web components for ACP-aware chat with streaming, permissions, elicitation. |
| `@agents-js/a2ui-host` | Surface | public | Browser-side A2UI v0.9 host and bridge. |
| `@agents-js/a2ui-renderer` | Surface | public | Maps A2UI component trees onto the `acp-*` Lit primitives. |
| `@agents-js/canvas-model` | Utility | public | Dependency-free canvas handoff helpers for inert A2UI payloads, OCIF-style preservation, and JSON Canvas previews. |
| `@agents-js/tools` | Utility | public | Unified `fetchContext` coordinator and `findTools` discovery surface. |
| `apps/internal-gateway` | App | internal | Reference host — ACP over A2A with permission mediation. |
| `apps/web-ui` | App | internal | Reference browser workspace built from `a2a-client` + `ui-components`. |

## Extras

Extras are opt-in integrations with specific external tools or environments. They live under `extras/` and are not bundled by core consumers — pull them in only when you need the integration they wrap.

| Package | Layer | One-liner |
|---------|-------|-----------|
| `@agents-js/plane` | Protocol | HMAC-verified Plane webhook handler with pluggable notifier transport. |
| `@agents-js/reporting` | Surface | Code-review reporting — markdown and JSON Canvas output. |
| `@agents-js/pi-extension` | Surface | Pi CLI extension that bridges Pi tool calls to A2A agents and exposes native Pi as an A2A peer. |
| `@agents-js/droid-acp` | Adapter | ACP adapter for Factory.ai's Droid CLI. |
| `@agents-js/pi-acp` | Adapter | ACP adapter for Mario Zechner's Pi coding agent. |
| `@agents-js/browser-runtime` | Adapter | Browser-native runtime for the docs meta-agent (WebLLM worker, ACP shim). |

## Docs

- [Getting Started](docs/getting-started.md)
- [Primitives](docs/primitives.md)
- [Protocols & Schemas](docs/protocols.md)
- [Harness Guide](docs/harness-guide.md)
- [Surfaces](docs/surfaces.md)
- [Streaming and Events](docs/streaming-and-events.md)
- [Package Dependencies](docs/develop/dependencies.md)

## Advanced Usage

### Browser smoke test

```sh
bun run browser:smoke
```

### Live browser E2E

```sh
bun run e2e:web:live -- --runtime claude
```

## From source

For working on `agents-js` itself rather than consuming it:

```sh
mise install
bun run setup --runtime claude
bun run dev --runtime claude
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor workflow.

## Project links

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [LICENSE](LICENSE) — MIT
