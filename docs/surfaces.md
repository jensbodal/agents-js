---
title: Surfaces
diataxis: howto
---

# Surfaces

> **Status:** Beta · **Known limitations:** Agent Registry is trusted-network-only (no auth, no schema validation, no ACL — see banner in [Agent Registry](#agent-registry)); third-party A2A interop pending; multi-tenant isolation is per-process only

The checked-in surfaces — browser shell, CLI, and multi-agent dispatch — let you run, connect to,
and route between ACP runtimes from your local machine. This page covers the browser surface, the
CLI surface, multi-agent patterns, the agent registry, runnable examples, and the full runtime
matrix.

## Browser

Run a local browser chat surface and talk to your own ACP runtime — claude, codex, opencode, pi,
gemini, or any other supported harness — entirely on your machine. The shell, the gateway, and the
agent all live on localhost.

### Minimum Commands

If you want the fastest path from source to a browser session:

```sh
mise install
bun run setup --runtime claude
bun run dev
```

Use the printed `Open URL`, press `Connect`, and send `Hello`.

### First Steps

The launcher prints:

- `Gateway URL`
- `Gateway WS URL`
- `Web UI URL`
- `Open URL`

Use the printed `Open URL`. It includes the discovered target URLs for that run and is the most
reliable way to land in the correct browser state on first load.

Once the app is open:

1. wait for the connect dialog to finish target inspection
2. press `Connect`
3. send `Hello`
4. send `What is the last message I sent?`

That sequence proves the local browser shell, the gateway connection, and basic session continuity.

### What The Browser App Does

The browser experience in this repo is one connected app:

- `apps/web-ui` renders the browser shell
- `apps/internal-gateway` provides the local A2A bridge to an ACP runtime
- `@agents-js/ui-components` provides the reusable UI building blocks inside that shell

In a normal session you will see:

- a connect dialog before the first connection
- a transcript once connected
- a prompt input for turns
- runtime and session metadata in the shell
- a debug panel for card, session, and trace details
- a conditional `Model` selector when the connected runtime advertises models

When a runtime requests extra interaction, the browser app can also surface:

- an elicitation form
- an authentication selector
- workflow or runtime state notices

### Browser Workflows

You can run the browser interface in several ways depending on your setup:

- **Integrated browser + gateway** (`bun run dev`): best for local development against a live runtime.
- **Browser-only** (web UI in one terminal, gateway in another): run `vp run @agents-js/web-ui#dev` for the web UI, then `agents-js serve --harness <id>` in a second terminal — best when you want to control the gateway and browser separately.
- **Separate processes** (CLI in one terminal, web UI in another): best when you need independent lifecycle control.

See [Profiles](#profiles) for runtime-specific launch options.

### Protocol Context

The browser path crosses the repo's main public protocol boundary:

- the browser shell talks to the gateway over **A2A**
- the gateway manages the local agent runtime over **ACP**
- both layers sit on **JSON-RPC 2.0**
- structured input still comes from ACP-carried schema payloads, while **AG-UI** and **A2UI**
  remain alignment references rather than transport claims

See [Protocols & Schemas](/protocols) for the full standards map and the host-owned
extension boundaries.

### Runtime And Model Behavior

- the connect dialog can preload the launcher-discovered gateway target
- runtime metadata can appear before connect when the local host bridge is active
- the `Model` selector only appears when the runtime advertises ACP models
- runtime switching is handled inside the browser shell when the gateway supports it

If the runtime is unavailable or fails startup, the browser shell should stay recoverable instead of
failing silently.

### Troubleshooting

If the browser path is not behaving correctly:

- inspect the debug panel for card and session state
- confirm the gateway URL printed by the launcher matches what the connect dialog is using
- verify the chosen runtime is installed and reachable on `$PATH`

## CLI

Talk to any ACP runtime from your terminal, or expose one over A2A so other tools — browsers,
gateways, MCP bridges, other agents — can reach it. Two flows live here:

- **Connect from a terminal** — drive a running A2A server turn by turn with `agents-js client`.
- **Serve an ACP runtime over A2A** — launch a curated runtime behind the gateway with
  `agents-js serve`, or drop down to a raw stdio proxy with `agents-js acp`.

### Minimum Commands

If you want the shortest terminal-first flow from source:

```sh
mise install
bun run setup --runtime claude
vp run @agents-js/cli#serve -- --harness claude
```

Then, in a second terminal:

```sh
vp run @agents-js/cli#client -- --url http://127.0.0.1:<printed-port>
```

### Recommended First Terminal Flow

1. start a runtime:
   ```sh
   agents-js serve --harness claude
   ```
2. connect with the client:
   ```sh
   agents-js client --url http://127.0.0.1:<printed-port>
   ```
3. send:
   - `Hello`
   - `What is the last message I sent?`

If you are working from the monorepo instead of an installed package, replace `agents-js` with the
`vp run @agents-js/cli#... --` forms shown above.

### Install Paths

#### Published package

```sh
npm install -g @agents-js/cli
agents-js serve --harness claude
```

The published CLI is Bun-backed, so the installed command still expects `bun` on `PATH`.
It includes the Zed-maintained `claude-agent-acp` and `codex-acp` adapter packages as direct
dependencies. Full external CLIs such as `opencode` and `gemini` still need to be installed by the
operator.

#### Monorepo workspace

```sh
vp run @agents-js/cli#serve -- --harness claude
vp run @agents-js/cli#client -- --url http://127.0.0.1:<printed-port>
```

### `serve`

Use `serve` to launch a local ACP runtime through the A2A gateway.

```sh
agents-js serve --harness claude
agents-js serve --harness opencode --profile clean-room
agents-js serve
```

What `serve` gives you:

- a local A2A base URL
- an agent card URL
- runtime-specific launch handling for curated ACP runtimes

Pass `--harness <id>` for any curated runtime listed in the [Runtime Matrix](#runtime-matrix).
Use `--profile <name>` for a named launch context, or omit `--harness` when `serve.harness`
is configured.

#### Profiles

Profiles let you run a curated runtime with a named launch context:

```sh
agents-js serve --harness opencode --profile clean-room
```

Use profiles when you want a cleaner or more isolated runtime environment without changing the base
CLI workflow.

### `client`

Use `client` to connect to an A2A server from the terminal.

```sh
agents-js client --url http://127.0.0.1:<printed-port>
agents-js client --card http://127.0.0.1:<printed-port>/.well-known/agent-card.json
```

Useful options:

- `--header name:value`
- `--context-id <id>`
- `--task-id <id>`
- `--probe`
- `--raw`
- `--no-poll`

The client surfaces:

- target and capability inspection
- a turn-by-turn transcript
- streamed task state
- debug records and raw protocol views

### `acp`

Use `acp` when you need a stdio-to-stdio ACP proxy instead of the higher-level gateway flow.

```sh
agents-js acp --harness claude
agents-js acp --harness opencode --profile clean-room
```

This command is useful for embeddings or tooling that need an ACP-compatible subprocess boundary.

The first stdout chunk from the runtime is validated as ndJSON with a `jsonrpc` field. If the
runtime prints shell banners, plugin warnings, or other non-protocol bytes before the first
JSON-RPC reply, `acp` fails fast with exit code `2` and a diagnostic on stderr — replacing the
prior silent-hang failure mode. The helpers are exported as `inspectFirstChunk` and
`formatContaminationError` from `@agents-js/cli`.

### Subcommand Reference

The flag tables below are extracted from the CLI parser specs themselves
(`packages/cli/src/{acp,bridge,serve,mcp,send}.ts`); they enumerate every option the
parser accepts on each subcommand. The narrative subsections above describe expected
flows; this reference is the canonical list. The `client` subcommand is documented in
its own subsection above and is not included here.

!!!include(_generated/cli-command-table.md)!!!

### Protocol Context

The CLI exposes all three of the repo's primary wire layers:

- `serve` exposes an **A2A** gateway over HTTP + SSE
- `client` consumes that **A2A** surface from the terminal
- `acp` keeps the lower-level **ACP** stdio boundary visible when you need it directly
- both ride on **JSON-RPC 2.0**, while runtime manifests and elicitation schemas provide the main
  repo-owned schema surfaces above the transport layer

See [Protocols & Schemas](/protocols) for the standards map and the extension seams.

## Multi-Agent Patterns

Your agent doesn't have to work alone. With `agents-js`, one user's agent can reach out
to another user's agent over A2A, ask it a question, get an answer back, and fold that
answer into the user's own conversation — all without either user leaving their host.

### What Cross-Host Delegation Lets You Do

User A is in Obsidian. They type `@docs-agent what changed in v0.2?`. The `docs-agent`
lives on a different machine, runs a different ACP runtime, and has a different tool
belt — maybe it's `opencode` pointed at a docs repo on User B's laptop. User A's host
catches the mention, dispatches it to User B's gateway over A2A, waits for the answer,
and prepends the result into User A's prompt before the local runtime ever sees it. The
local agent then composes a reply that cites and incorporates the delegated answer.

Neither user has to share machines, sync vaults, or agree on a runtime. Each side owns
its tools and permissions. The only shared state is a list of names and URLs.

### The Two-Host Setup

Two users, two machines, two hosts, one shared registry file per user.

**User A's machine:**

- A host — any of `apps/web-ui`, the `@agents-js/client` terminal harness, the
  `obsidian-acp-plugin`, or a custom embedder built on `@agents-js/acp-host`.
- A local ACP runtime subprocess spawned by that host (`claude`, `codex`, `opencode`,
  `pi`, `droid`, or `gemini`).
- A `~/.agents-js/registry.json` file listing every remote agent they want to reach.

**User B's machine:** exactly the same shape, independently.

**Example `~/.agents-js/registry.json`** (each user edits their own copy):

```json
{
  "agents": {
    "alice-coder": { "url": "http://alice.local:9200" },
    "bob-reviewer": { "url": "http://bob.local:9300" }
  }
}
```

The registry path can be overridden with the `AGENTS_JS_REGISTRY` environment variable.
The resolver lives in `packages/a2a-client/src/node.ts` and re-reads the file off disk
on every mention resolution — there is no in-process cache, so edits take effect on the
next turn without a restart.

### Starting The Two Hosts

The fastest end-to-end demo uses the reference gateway on each machine:

```sh
# On User A's machine
bun apps/internal-gateway/cli.ts --port 9200 --permission-mode yolo

# On User B's machine
bun apps/internal-gateway/cli.ts --port 9300 --permission-mode yolo
```

The reference gateway is the shortest path to a live A2A endpoint, but it is not the
only host. The `obsidian-acp-plugin` is the canonical embedder-style Host A in day-to-day
use, and any host built on `@agents-js/acp-host` can wire the same middleware. For the
embedder path, see [ACP Host Embedding](/harness-guide).

### Two Dispatch Modes: `@mention` vs `@@dispatch`

`agents-js` provides two distinct ways to reach a remote agent. They use the same
registry file but follow completely different code paths:

| | `@mention` | `@@dispatch` |
|---|---|---|
| **Syntax** | `@agent-name` anywhere in the prompt | `@@agent-name` at the start of the prompt |
| **Where it runs** | Hosts with a delegation hook: `beforePrompt` middleware or native Pi `before_agent_start` | Direct-dispatch hosts: gateway `HostA2AExecutor` or native Pi `input` hook |
| **What happens** | Host dispatches to mentioned peers, frames the peer response, then the local agent sees both | Host forwards the payload to the named agent and suppresses local agent processing |
| **Multiple targets** | Yes — all unique `@name` tokens dispatch in parallel via `Promise.allSettled` | No — one `@@` directive per message |
| **Response framing** | `<a2a-delegation-response>` in ACP host middleware; visible peer context in native Pi | Returned or displayed directly |
| **Code entry point** | `createA2AMentionMiddleware()` in `packages/a2a-client/src/middleware.ts`; native Pi peer mode in `extras/pi-extension/src/native-peer.ts` | `HostA2AExecutor.executeDirectDispatch()` in `apps/internal-gateway/host-executor.ts`; native Pi peer mode in `extras/pi-extension/src/native-peer.ts` |

A key implementation detail: when the `@mention` middleware sees a prompt that starts
with `@@`, it returns early without dispatching (see `parseDispatchDirective()` check in
`middleware.ts`). This ensures `@@dispatch` directives are never double-handled by the
mention-delegation path. The reference gateway handles them in `HostA2AExecutor`;
native Pi peer mode handles them in Pi's `input` hook before Pi starts a local turn.

### How `@mention` Dispatch Works

Once both hosts are running and each user's registry lists the other agent, here's what
happens when User A types `@bob-reviewer please look at this diff`:

1. **Host A receives the prompt.** User A's host calls `sendPrompt()` on its
   `ACPSessionController` from `@agents-js/acp-host`.

2. **The `beforePrompt` hook fires.** That hook was wired at session-start time to
   `createA2AMentionMiddleware(...)` from `@agents-js/a2a-client`. The canonical
   wiring lives in `obsidian-acp-plugin/src/session-lifecycle.ts`. The controller
   awaits the hook in `packages/acp-host/src/session-controller.ts` before any
   prompt bytes reach the local runtime.

3. **The middleware scans for `@name` tokens** using the regex in
   `packages/a2a-client/src/mention-parser.ts`. It finds `@bob-reviewer`. Email
   addresses like `user@example.com` are skipped because the regex requires the
   `@` to sit at start-of-string or after whitespace.

4. **It resolves the name** through the shared registry — reading
   `~/.agents-js/registry.json` off disk, no caching, on every mention. If the name
   isn't there, the middleware calls `onUnknownAgent` and leaves the mention as
   plain text so the local agent can still try to answer.

5. **It issues a blocking A2A `message/send`** to `http://bob.local:9300` with
   `stream: false, blocking: true` (hardcoded in
   `packages/a2a-client/src/middleware.ts`). Host A's turn pauses until Host
   B responds. If the prompt mentions multiple agents (e.g. `@alice-coder` and
   `@bob-reviewer`), all dispatches run in parallel via `Promise.allSettled`.

6. **Host B's gateway receives the A2A request** and routes it through its own
   `ACPSessionController.sendPrompt()`, which runs User B's local ACP runtime
   (`opencode`, in this example) to compose an answer.

7. **Host B's final text response** is returned over A2A to Host A.

8. **The middleware wraps the response** in an `<a2a-delegation-response>` framing
   block and prepends it to User A's original prompt content. The framing is
   authored in the `defaultBuildResponseBlock()` function in
   `packages/a2a-client/src/middleware.ts` and explicitly instructs User A's local
   agent to treat the delegated answer as authoritative, rather than
   re-investigating what `@bob-reviewer` means. The response block carries
   annotation metadata (`annotations._meta = { source: "a2a-delegation", agentName,
   agentUrl }`) so hosts can programmatically identify delegation content.

9. **User A's local runtime finally sees the prompt** — the framed answer first,
   then User A's original text. It composes its reply using the delegation.

10. **User A reads the final answer** in their host's UI, with the delegated content
    incorporated inline.

Native Pi peer mode uses the same user-facing shape inside Pi's own TUI. The Pi
extension handles `@agent-name ...` in Pi's `before_agent_start` hook, dispatches the
payload to the named A2A peer, injects the peer answer as visible context, and then lets
Pi's local model compose the final response.

### How `@@dispatch` Works

`@@dispatch` is a direct-dispatch feature. The reference gateway implements it in
`HostA2AExecutor`; native Pi peer mode implements it in Pi's `input` hook. In both
cases, a message that starts with `@@agent-name` is forwarded to the named agent without
involving the local model.

1. **The direct-dispatch host receives the turn.** In the gateway path, the user's
   message arrives at `HostA2AExecutor.execute()`. In native Pi peer mode, Pi calls the
   extension's `input` hook before starting a local turn.

2. **The host parses the `@@` directive** using `parseDispatchDirective()` from
   `packages/a2a-client/src/mention-parser.ts`. The regex requires `@@` at the start
   of the message (with optional leading whitespace): `^\s*@@([a-zA-Z0-9]...)`.

3. **It looks up the agent** in the registry. The gateway uses `loadRegistryFromDisk()`;
   native Pi peer mode reads the same `~/.agents-js/registry.json` path through the A2A
   client helpers. If the agent name is not found, the host reports an error listing
   available agents.

4. **It dispatches the payload** (everything after `@@agent-name`) to the target
   agent's URL via A2A `message/send` with `stream: false`.

5. **The response is returned or displayed directly.** The gateway returns the target
   answer as the A2A task result, with metadata tagging it as a dispatch
   (`agents-js.dispatch` in task metadata). Native Pi peer mode displays the peer answer
   in Pi via `pi.sendMessage(...)` and returns `handled` from the `input` hook so Pi's
   local model does not run.

**When to use `@@dispatch`**: Use it when you want to route a message to a specific
agent deterministically, without your local agent processing or composing around the
answer. It is a direct pipe — the host acts as a router, not a mediator.

**When to use `@mention`**: Use it when you want your local agent to incorporate
the remote agent's answer into its own response. The mention flow is richer — the
local agent sees the delegation result and can reason about it.

### What Each User Sees

- **User A** sees their own agent's final reply, which incorporates Bob's answer.
  User A does not see Bob's intermediate thinking — only the final text is fetched,
  because the middleware uses `stream: false`.
- **User B** sees their agent answering what looks like a normal incoming A2A turn
  in their own host's UI. They don't need to know that a human on the other side
  is driving the request indirectly.
- **Native Pi peer mode** keeps both sides visible in Pi. Pi B receives the inbound
  A2A prompt in its TUI; Pi A either displays the `@@` peer answer directly or injects
  the `@` peer answer as context before Pi A composes its own reply.

### Surfacing Delegation Progress In The Host UI

`createA2AMentionMiddleware()` exposes three lifecycle callbacks so hosts can
render "delegating to @agent" activity in their own workflow or transcript UI
without wrapping the middleware:

- `onDispatchStart({ agentName, promptText, sessionId })` — fires immediately
  before the A2A `sendTurn`, after the target has been resolved and connected.
- `onDispatchSuccess({ agentName, agentUrl, promptText, sessionId, result })`
  — fires after a successful `sendTurn` and before the reply is folded into
  the outgoing response blocks.
- `onDispatchError({ agentName, promptText, sessionId, error })` — fires when
  a started dispatch fails (resolution, network, or `sendTurn` rejection).

`onDispatchSuccess` and `onDispatchError` are mutually exclusive terminals for
the same dispatch. Unknown-agent mentions do not produce an `onDispatchStart`;
they produce `onUnknownAgent` instead. All hooks are awaited, so hosts can
render an activity indicator synchronously before the wire call begins.

```ts
import { createA2AMentionMiddleware } from "@agents-js/a2a-client";

const middleware = createA2AMentionMiddleware({
  agents: { bob: { url: "http://bob.example.internal" } },
  onDispatchStart({ agentName }) {
    activityUi.push(`Delegating to @${agentName}…`);
  },
  onDispatchSuccess({ agentName }) {
    activityUi.resolve(`@${agentName} responded`);
  },
  onDispatchError({ agentName, error }) {
    activityUi.fail(`@${agentName} failed: ${String(error)}`);
  },
});
```

### Known Limits

- **Blocking dispatch.** User A's turn pauses while Bob's agent thinks. A slow
  remote agent means a slow local conversation. The ACP host has a 1-hour prompt
  timeout as a backstop. Hosts can surface intermediate "delegating to @agent"
  activity via the `onDispatchStart` / `onDispatchSuccess` / `onDispatchError`
  lifecycle hooks (see above), but Bob's step-by-step reasoning is not streamed
  to User A.
- **Non-streaming.** The `stream: false` flag in the middleware is load-bearing.
  User A does not see Bob's step-by-step reasoning, only the final text.
  Streaming delegated reasoning is not part of the beta @mention contract.
- **Per-contextId session lanes, single upstream agent.** `apps/internal-gateway`
  routes concurrent prompts by `contextId` into independent `SessionLane`s.
  Each lane has its own in-flight bookkeeping and can optionally own a dedicated ACP
  controller via the `controllerFactory` hook — distinct contextIds run in
  parallel. One gateway instance still fronts a single upstream agent process,
  so multi-agent or multi-tenant topologies still require separate gateways,
  but concurrent users or tabs under one gateway no longer serialize through a
  global mutex.
- **No registry sync.** `~/.agents-js/registry.json` lives on each user's local
  disk. New agents need to be added on every machine that wants to reach them.
  This is fine for a homelab or a trusted private network, but it is not a substitute for
  service discovery.
- **No A2A authentication.** The registry is plain JSON and agent cards are served
  unauthenticated at `/.well-known/agent-card.json`. Assume a trusted private network,
  VPN, or equivalent — not the public internet.

## Agent Registry

::: danger Trusted-network only
The registry is **plain JSON, unauthenticated, and unsigned**. Agent cards are
served at `/.well-known/agent-card.json` with no auth. Cross-host A2A dispatch
through this registry is appropriate for a homelab, VPN, or equivalent trusted
network. **It is not safe to expose to the public internet** — there is
no ACL, no endpoint identity, no schema validation on registry entries, and no
trace redaction guarantee. Public-internet hardening (auth, registry validation,
endpoint identity) is a separate track. See `docs/streaming-and-events.md`
deliberate-limits and the [Known Limits](#known-limits) subsection above.
:::

`agents-js` resolves `@mention` and `@@dispatch` targets through a shared registry file
that lives on the user's filesystem.

### Auto-registration on `serve`

Starting a gateway with `bun run dev` or `agents-js serve` automatically writes the
gateway's name + URL into `~/.agents-js/registry.json` and starts a periodic sync
with any peer URLs already in the file. You don't need to edit the registry by
hand to **be discoverable** — that happens on startup. You only edit the file when
**adding a peer machine** so this gateway can dispatch to it.

Source-of-truth wiring: `packages/cli/src/serve.ts` and
`apps/internal-gateway/index.ts` both call `startRegistrySync()` on startup, which
runs auto-registration once and then a periodic peer pull. Peer pulls hit each known
peer's `GET /.well-known/agents-js-registry.json`, merge in their entries (tagged
`source: "sync"`), and serve this gateway's own version of that endpoint for other
gateways to pull from. Override the sync interval with
`AGENTS_JS_SYNC_INTERVAL_MS=<ms>`.

Native Pi peer mode uses the same registry file for local demos. When launched with
`AGENTS_JS_PI_NATIVE=1`, `@agents-js/pi-extension` registers `AGENTS_JS_PI_NAME` at the
localhost endpoint selected by `AGENTS_JS_PI_PORT`. Set `AGENTS_JS_REGISTRY` on every
Pi process if you want an isolated demo registry.

The static-file editing flow below still works — it's how you bootstrap the first
peer URL into a fresh `registry.json` before the auto-sync chain takes over.

### File Format

The registry is plain JSON with one top-level key, `agents`, mapping short names to
target descriptors:

Use real reachable URLs in your own registry. The `192.0.2.100` address below is
TEST-NET-1, reserved for documentation examples.

```json
{
  "agents": {
    "code-reviewer": { "url": "http://localhost:3000" },
    "knowledge-compiler": { "url": "http://192.0.2.100:5000" }
  }
}
```

The name is what a user types after `@` in a prompt. The on-disk
shape under `agents` is keyed by agent name; each per-agent value
object does NOT repeat the name. The `kind` field discriminates
remote A2A agents from locally spawnable ACP harnesses, and is
optional — if omitted, it defaults to `"a2a"` for backward
compatibility with pre-discriminator registries.

The two entry shapes (input form, before normalization) are:

- **`kind: "a2a"`** (default) — `{ kind?: "a2a"; url: string }`. The
  `url` must point at an A2A-compatible HTTP endpoint that serves an
  agent card at `<url>/.well-known/agent-card.json`.
- **`kind: "acp"`** — `{ kind: "acp"; harness: string; command?: string; args?: string[]; env?: Record<string, string>; workspaceFlag?: string }`.
  The `harness` id selects the ACP runtime to spawn locally; see
  [Runtime Matrix](#runtime-matrix) for supported harness ids.

The loader (see
[`packages/a2a-client/src/registry.ts`](https://github.com/jensbodal/agents-js/tree/main/packages/a2a-client/src/registry.ts))
parses each entry into an `AgentEntry` discriminated union for in-memory
use; that normalized shape carries `name` injected from the keying
field, but users do not write `name` in the on-disk file.

For `kind: "a2a"` entries, the URL must point at an A2A-compatible HTTP endpoint that
serves an agent card at `<url>/.well-known/agent-card.json`. For `kind: "acp"` entries,
the harness id selects the ACP runtime to spawn locally; see [Runtime Matrix](#runtime-matrix)
for supported harness ids. The `kind` field defaults to `"a2a"` when omitted, for
backward compatibility with pre-discriminator registries.

### Where The Registry Lives

**Default path:** `~/.agents-js/registry.json` (expanded with `$HOME`).

**Override:** set the `$AGENTS_JS_REGISTRY` environment variable to an absolute path.
Hosts that honor the override (including the obsidian-acp-plugin and the reference
browser app) will read the override path instead of the default. Invalid or
unreadable paths fail open — the host continues running but cannot resolve mentions.

The file does NOT need to exist at host-start time. If it's missing, the registry
returns null on every resolve and the host treats `@mention` tokens as plain text.

### How Hosts Read The Registry

There are two registry implementations, both reading the same file:

- **`createSharedAgentRegistry`** (`packages/a2a-client/src/node.ts`) is the
  factory used by `@mention` middleware. It re-reads the JSON file from disk on
  every `resolve(name)` call and does not cache across calls. This is the path
  most hosts use.
- **`AgentRegistry`** (`packages/a2a-client/src/registry.ts`) is a class-based
  registry that caches the parsed config in memory and caches fetched agent cards
  with a 60-second TTL. Call `refresh()` to force a reload.

The gateway's `@@dispatch` path uses its own `loadRegistryFromDisk()` helper
(`apps/internal-gateway/agent-registry.ts`), which is synchronous and re-reads
on every call.

Native Pi peer mode reads the same registry file through the A2A client helpers for
both `@` and `@@` directives, and writes its own entry during Pi session startup.

Practical consequence: you can edit `~/.agents-js/registry.json` in your editor while
a host is running, and the next prompt that uses a new mention will see the update
immediately — no host restart required. Flip side: every mention resolve on the
`createSharedAgentRegistry` path costs one filesystem read, which is cheap in
practice but noteworthy if you have a pathologically busy host.

Agent cards fetched from `<url>/.well-known/agent-card.json` are cached by the
`AgentRegistry` class with a 60-second default TTL (see
`packages/a2a-client/src/registry.ts`). The `createSharedAgentRegistry` factory
does not fetch cards itself — it returns an `AgentTargetInput` (just the URL),
and card fetching happens downstream in the `A2AClientProvider.connect()` step.

### Setting Up Two Peers On The Same Trusted Network

Assume two users on a trusted network: Alice on `alice.agent.example`, Bob on
`bob.agent.example`. Each user wants to be able to `@mention` the other user's
agent.

**On Alice's machine:**

```sh
cat > ~/.agents-js/registry.json <<'EOF'
{
  "agents": {
    "bob-reviewer": { "url": "http://bob.agent.example:9300" }
  }
}
EOF
```

**On Bob's machine:**

```sh
cat > ~/.agents-js/registry.json <<'EOF'
{
  "agents": {
    "alice-coder": { "url": "http://alice.agent.example:9200" }
  }
}
EOF
```

**Run a gateway on each side** (see [Multi-Agent Patterns](#multi-agent-patterns)):

```sh
# On alice.agent.example
bun apps/internal-gateway/cli.ts --port 9200 --permission-mode yolo

# On bob.agent.example
bun apps/internal-gateway/cli.ts --port 9300 --permission-mode yolo
```

Now Alice can type `@bob-reviewer please look at this diff` in her host, and the
middleware will dispatch to Bob's gateway. Bob can symmetrically type
`@alice-coder what changed yesterday?`.

### Security Posture

The registry is plain JSON with no signing, no authentication, and no ACL. Every
process on the user's machine that can read `~/.agents-js/` can dispatch to any
listed agent.

Agent cards at `<url>/.well-known/agent-card.json` are served unauthenticated.
Requests to the listed URLs are plain A2A with no mutual TLS or tokens.

**Assume a trusted network.** Homelab, VPN, or equivalent trusted private network.
Do not use this registry to point at public internet agents without an auth layer
in front. Do not add URLs you don't control to a registry on a shared machine.

### Known Limits

- **No sync.** Editing one user's registry does not propagate to any other user's
  registry. This is by design for the single-user-per-machine model. A future
  release may add optional sync via a trusted filesystem location or a lightweight
  discovery protocol.
- **No schema validation today.** Malformed JSON fails open (empty registry). Valid
  JSON with unexpected fields is ignored. Consider running `jq . ~/.agents-js/registry.json`
  if you suspect a typo.
- **No agent liveness probes.** The registry does not know whether listed agents
  are actually reachable. A dispatch to a dead URL fails at request time with an
  error that surfaces in the middleware's `onDispatchError` callback.

## Examples

Follow these recipes to spin up a browser chat, run a terminal client against your own runtime,
and route between registered agents. Each one produces a working session you can talk to.

### Local Browser Workflow

Start the integrated browser path:

```sh
bun run dev --runtime claude
```

Then:

1. open the printed `Open URL`
2. press `Connect`
3. send `Hello`
4. send `What is the last message I sent?`

Use this when you want the quickest visual first run.

### Local CLI Workflow

Start the gateway:

```sh
vp run @agents-js/cli#serve -- --harness claude
```

Connect the terminal client:

```sh
vp run @agents-js/cli#client -- --url http://127.0.0.1:<printed-port>
```

Use this when you want a terminal-only local session.

### Choose A Runtime

Use a curated runtime directly:

```sh
agents-js serve --harness claude
agents-js serve --harness gemini
agents-js serve --harness pi
```

Use an isolated runtime context with a profile:

```sh
agents-js serve --harness opencode --profile clean-room
```

### Multi-Agent Dispatch With Gateways

Route messages between gateway-hosted agents using host-wired `@mentions` and
`@@dispatch` directives.

**1. Set up the agent registry** at `~/.agents-js/registry.json`:

```json
{
  "agents": {
    "code-reviewer": { "url": "http://localhost:3001" },
    "knowledge-compiler": { "url": "http://localhost:3002" }
  }
}
```

**2. Start two gateways** on different ports:

```sh
agents-js serve --harness opencode --profile clean-room --port 3001
agents-js serve --harness claude --port 3002
```

**3. Connect a client** to either gateway:

```sh
agents-js client --url http://localhost:3001
```

**4. Use dispatch directives** in the client:

- `@@knowledge-compiler summarize this file` -- deterministic routing: the entire message is
  forwarded to `knowledge-compiler` without the local agent seeing it.
- `@knowledge-compiler what do you think?` -- delegation: the local agent sees the message
  and decides how to involve `knowledge-compiler`.

The `@@` prefix consumes the full message for direct forwarding. The single `@` prefix is an
annotation the host can act on when it installs A2A mention middleware.

### Two Native Pi Peers

Use this recipe when Pi itself is the primary operator surface. Start two Pi TUI
processes from the repo root:

```sh
AGENTS_JS_PI_NATIVE=1 AGENTS_JS_PI_NAME=pi-a AGENTS_JS_PI_PORT=3101 pi -e ./extras/pi-extension/src/index.ts
AGENTS_JS_PI_NATIVE=1 AGENTS_JS_PI_NAME=pi-b AGENTS_JS_PI_PORT=3102 pi -e ./extras/pi-extension/src/index.ts
```

Each process registers its localhost A2A endpoint in `~/.agents-js/registry.json`. In
Pi A, type:

```text
@pi-b review this plan in one sentence
@@pi-b answer directly: what is the smallest next step?
```

The `@pi-b` prompt sends the request to Pi B, injects Pi B's answer as visible context,
and lets Pi A compose the final response. The `@@pi-b` prompt sends the request to Pi B,
shows Pi B's answer directly in Pi A, and skips Pi A's local model turn.

`agents-js client` and the web UI can still connect as secondary drivers or observers:

```sh
agents-js client --url http://127.0.0.1:3101
agents-js client --url http://127.0.0.1:3102
```

### Debugging Connection Or Runtime Issues

If a local gateway is not responding:

- Check that the runtime is installed on your `$PATH` (e.g., `which claude`, `which opencode`).
- Verify your environment contains required auth (e.g., `ANTHROPIC_API_KEY` for Claude).
- Confirm the gateway URL is correct — check the printed URL or `~/.agents-js/registry.json`.
- If connecting from a peer, verify the remote gateway's URL is reachable from your network.
- For native Pi peer mode, confirm Pi is logged in to its provider and `AGENTS_JS_PI_PORT`
  is not already in use.
- If `@@dispatch` returns `agent_not_found`, check spelling and the `AGENTS_JS_REGISTRY`
  path used by the gateway or native Pi process.

If you see "Runtime not found" or similar errors, run `agents-js setup --runtime <id>` to verify the harness is available.

## Runtime Matrix

This is the reference for the curated ACP runtimes supported by the checked-in Browser and CLI
surfaces.

### Supported Runtimes

!!!include(_generated/runtime-matrix.md)!!!

A `custom` runtime is also supported by the ACP contract — any command is acceptable if it speaks ACP over stdio.

### Behavior

- the gateway resolves the selected runtime before boot
- the operator CLI exposes the curated runtime selection through `serve`
- curated runtimes use their normal local environment by default
- explicit isolation or alternate launch context belongs behind `--profile <name>`, not behind hidden default behavior

### Provenance

- `opencode` is not maintained in this repo
- `claude-agent-acp` is not maintained in this repo; the published CLI depends on Zed's package so the default installed `claude` path works without a separate global adapter install
- `codex-acp` is not maintained in this repo; the published CLI depends on Zed's package, and OpenAI endorses Zed's adapter as the ACP integration path (see openai/codex#2785)
- `pi-acp` is maintained in this repo as `@agents-js/pi-acp`; it wraps `@mariozechner/pi-coding-agent` via the native `pi --mode rpc` NDJSON stream
- `droid-acp` is maintained in this repo as `@agents-js/droid-acp`; it wraps Factory.ai's `droid` CLI via per-turn `droid exec --output-format stream-json` invocations
- `trial-agent` is available for testing and is not a production runtime.
- `gemini` is not maintained in this repo
- the repo wires the runtimes into the gateway and CLI.

### Auth

Each harness picks up credentials from the operator's environment; the gateway does not
validate auth at spawn time. If credentials are missing, the harness itself emits an error.

| Runtime    | Env vars forwarded                           | Notes                                                                                        |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `opencode` | Operator env (no provider-specific forward)  | Configure via opencode's own config.                                                         |
| `claude`   | `ANTHROPIC_API_KEY`                          | Forwarded to the agent process only (not to terminal tools).                                 |
| `codex`    | `CODEX_API_KEY`, `OPENAI_API_KEY`            | Either works; ChatGPT-subscription `codex login` is local-only.                              |
| `pi`       | Operator env (no provider-specific forward)  | Pi manages auth internally via its `/login` TUI; ~/.pi stores credentials.                   |
| `droid`    | `FACTORY_API_KEY`                            | Also reads droid's local credential cache under `~/.factory` when FACTORY_API_KEY is absent. |
| `gemini`   | Operator env (no provider-specific forward)  | Configure via gemini CLI's own auth.                                                         |

Then connect with:

```sh
agents-js client --url http://127.0.0.1:<printed-port>
```

Use the URL printed by `serve`. The gateway does not assume a fixed port unless you pass one explicitly.

### Profiles

Profiles are top-level config entries in `.agents-js/config.json` or `~/.config/agents-js/config.json`.

- no profile: use the curated runtime without a named profile; command resolution still follows the runtime-specific rules above
- `--profile <name>`: use a named runtime-bound launch context with derived or overridden roots, env, and args
- missing profiles are auto-created in the project config

For curated `opencode`, profiles are the cleaner isolated configuration when personal config or plugins add stdout noise around ACP startup.

Example:

```json
{
  "profiles": {
    "clean-room": {
      "runtime": "opencode"
    }
  }
}
```

For curated `pi`, prefer a plain harness config unless you intentionally want to isolate
Pi from its normal `~/.pi` state and provider environment:

```json
{
  "serve": {
    "harness": {
      "kind": "curated",
      "runtime": "pi"
    }
  }
}
```

### Profile Reference

#### Profile Configuration Schema

Each profile entry lives under the `profiles` key in `.agents-js/config.json` (project) or `~/.config/agents-js/config.json` (user). The profile name is the object key.

```json
{
  "profiles": {
    "<profile-name>": {
      "runtime": "opencode" | "claude" | "codex" | "pi" | "droid" | "gemini",
      "args": ["--flag", "value"],
      "env": {
        "KEY": "value"
      },
      "roots": {
        "home": "/custom/home",
        "config": "/custom/.config",
        "data": "/custom/.local/share",
        "state": "/custom/.local/state",
        "cache": "/custom/.cache"
      }
    }
  }
}
```

| Field     | Type                      | Required | Description                                                              |
| --------- | ------------------------- | -------- | ------------------------------------------------------------------------ |
| `runtime` | `"opencode"`, `"claude"`, `"codex"`, `"pi"`, `"droid"`, or `"gemini"` | Yes      | Which curated runtime this profile targets.                              |
| `args`    | `string[]`                | No       | Extra CLI arguments appended after the runtime's base args.              |
| `env`     | `Record<string, string>`  | No       | Additional environment variables merged into the profile's derived env.  |
| `roots`   | `object`                  | No       | Override individual directory roots instead of using the derived layout. |

#### Profile Directory Structure

When a profile is applied, the gateway derives an isolated directory tree under the profiles root. The profiles root is adjacent to the config file that defines the profile.

```
.agents-js/profiles/
  <runtime>/
    <profile-name>/
      .cache/
      .config/
      .local/
        share/
        state/
```

For example, a profile named `clean-room` targeting `opencode` with a project config at `.agents-js/config.json` produces:

```
.agents-js/profiles/opencode/clean-room/
  .cache/
  .config/
  .local/share/
  .local/state/
```

The `roots` field can override any of these paths individually when the default layout does not suit the runtime.

#### `--profile` Flag Usage

```sh
# Serve with a named profile
agents-js serve --harness opencode --profile clean-room

# Serve claude with a profile
agents-js serve --harness claude --profile isolated-claude
```

The `--profile` flag always requires a `--harness` (or explicit `--runtime`) argument. The
profile's `runtime` field must match the selected harness.

#### Default vs Profile Behavior

| Aspect         | No Profile (default)                          | With `--profile`                                      |
| -------------- | --------------------------------------------- | ----------------------------------------------------- |
| Environment    | Inherits the operator's full shell environment | Isolated `HOME`, `XDG_*` vars pointing to profile dir |
| Config files   | Uses the runtime's normal config path          | Reads from the profile's derived config root           |
| Extra args     | None beyond the runtime's base args            | Profile `args` appended after base args                |
| Custom env     | None                                           | Profile `env` merged on top of derived XDG vars        |
| Determinism    | Affected by user plugins, shell config, etc.  | Deterministic — isolated from user-specific state      |
| Stdout purity  | May be contaminated by plugins or shell init  | Clean — no user config means no plugin stdout noise    |

#### Profile Auto-Creation

When the `serve` command receives a `--profile <name>` that does not exist in either the project or user config, the CLI auto-creates the profile entry in the project config (`.agents-js/config.json`). The auto-created profile contains only the required `runtime` field, inheriting all default behavior:

```json
{
  "profiles": {
    "my-new-profile": {
      "runtime": "opencode"
    }
  }
}
```

This lets operators create clean-room profiles on the fly without editing config files first.

#### Full Config Example

A complete `.agents-js/config.json` with multiple profiles targeting different runtimes:

```json
{
  "profiles": {
    "clean-room": {
      "runtime": "opencode"
    },
    "debug-opencode": {
      "runtime": "opencode",
      "args": ["--verbose"],
      "env": {
        "OPENCODE_LOG_LEVEL": "debug"
      }
    },
    "isolated-claude": {
      "runtime": "claude",
      "env": {
        "CLAUDE_LOG_LEVEL": "trace"
      }
    },
    "custom-roots": {
      "runtime": "opencode",
      "roots": {
        "home": "/tmp/acp-sandbox",
        "config": "/tmp/acp-sandbox/.config",
        "data": "/tmp/acp-sandbox/data",
        "state": "/tmp/acp-sandbox/state",
        "cache": "/tmp/acp-sandbox/cache"
      }
    }
  }
}
```
