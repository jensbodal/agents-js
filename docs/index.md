---
layout: home
diataxis: landing

hero:
  name: agents-js
  text: One runtime. Many reaches.
  tagline: A TypeScript library tying together the latest versions of ACP, A2A, AG-UI, A2UI, and MCP — plus a CLI that wires them together.
  image:
    src: /protocol-stack.svg
    alt: agents-js protocol stack
  actions:
    - theme: brand
      text: Start in 5 minutes
      link: /getting-started
    - theme: alt
      text: How it works
      link: /protocols-primer

features:
  - title: ACP as the runtime contract
    details: Every agent is an ACP subprocess speaking stdio NDJSON via AgentSideConnection. Same shape for trial, claude, opencode, gemini, pi, droid, codex, or anything you build.
  - title: A2A as the network contract
    details: Gateways speak JSON-RPC 2.0 over HTTP/SSE. Each gateway auto-registers in ~/.agents-js/registry.json and syncs with peers on the same trusted network — no central server.
  - title: Mention vs dispatch, not magic
    details: "@mention resolves through host policy (delegation with audit). @@dispatch routes through a direct-dispatch host such as the gateway or native Pi peer mode (no policy gate). Two distinct surfaces, both deterministic."
  - title: A2UI declarative surfaces
    details: Agents emit UI as data; renderers (web-ui, Obsidian) bind it to native components. No agent-side DOM. No surface-side prompt logic.
  - title: Bridge into any MCP host
    details: The same gateway exposes registered ACP agents as MCP tools to Claude Code, Cursor, Zed, or any MCP-aware host. One agent process; many operator UXs.
  - title: Local-operator first
    details: Single-tenant, trusted-network posture. Private network, VPN, or single-machine. Public-internet hardening is a separate, declared track.
---

## Two tracks, one runtime

### CLI users start here

Run any ACP coding agent as an A2A server, talk to it from a terminal, and bridge it into MCP hosts — without writing TypeScript.

```sh
# One-off, no install
bunx @agents-js/cli --help

# Or install globally
npm i -g @agents-js/cli
agents-js --help
```

You already have an ACP harness (`claude`, `opencode`, `gemini`, `pi`, `droid`, `codex`, or your own). One command puts it on the network as an A2A peer:

```sh
agents-js serve --harness claude --port 9000
```

The gateway boots, registers itself in `~/.agents-js/registry.json`, and starts answering `/a2a` on the port. Any peer on the same trusted network can now reach it. See [Surfaces](/surfaces) and `packages/cli/README.md` for full options.

For the full launcher walkthrough — clone, `bun run dev`, browser session, session-continuity walkthrough — see [Get Started](/getting-started).

### Library users start here

Install only the protocol packages you need:

```sh
bun add @agents-js/acp @agents-js/a2a @agents-js/a2a-client
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

Per-package surfaces are documented under [Build → Primitives](/primitives) and [Reference → Protocols](/protocols).

## Hello, world — for real

The `hello-world` shape that actually runs. **An agent is an ACP subprocess**, not an in-process class:

```ts
// tests/trial-agent/bin/trial-agent.ts (excerpt)
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin)  as unknown as ReadableStream<Uint8Array>,
);

new AgentSideConnection((conn) => ({
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentInfo: { name: "trial-agent", version: "0.2.0" }, agentCapabilities: {}, authMethods: [] };
  },
  async newSession() { return { sessionId: "trial-1" }; },
  async prompt(req) {
    await conn.sessionUpdate({
      sessionId: req.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello, world" } },
    });
    return { stopReason: "end_turn" };
  },
  async cancel() {},
  async authenticate() { return {}; },
}), stream);
```

Host that binary on a gateway with one command:

```bash
agents-js serve --harness trial --port 9000
```

`--harness trial` selects the curated trial-agent runtime (the same shape works for `claude`, `opencode`, `gemini`, `pi`, `droid`, `codex`, or `--harness custom --acp-command <bin>` for anything else). The gateway boots, registers itself in `~/.agents-js/registry.json`, and starts answering `/a2a` on the port.

From any client on the network:

```bash
curl -X POST http://my-gateway.example.internal:9000/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": "req-1",
    "method": "message/send",
    "params": {
      "message": { "role": "user", "parts": [{ "kind": "text", "text": "Hello" }] }
    }
  }'
```

That's the whole stack. ACP downstream, A2A upstream, no glue you have to write.

The full file is `tests/trial-agent/bin/trial-agent.ts` — ~200 lines including dispatch wiring and session bookkeeping.

## What you get

- **Browser chat** — the reference web UI connects over A2A + AG-UI streaming. [Surfaces → Browser](/surfaces#browser)
- **CLI client** — a second terminal reaches the same session. [Surfaces → CLI](/surfaces#cli)
- **Agent-to-agent** — `@mention` resolves through the auto-populated registry; `@@dispatch` routes deterministically. [Primitives](/primitives)
- **MCP host** — the same gateway answers Claude Code, Cursor, Zed, or any MCP host via the bridge. [Surfaces → MCP host](/surfaces#mcp-host)

## What this is not

- **Not a framework** — it doesn't tell you how to build the agent itself.
- **Not an agent runtime** — bring your own ACP harness (claude-agent-acp, opencode, gemini, pi, droid, codex, or custom).
- **Not a protocol spec body** — agents-js implements ACP, A2A, MCP, AG-UI, A2UI as defined upstream.
- **Not a hosted service** — you run the gateway, the registry, and your own runtimes. No telemetry, no SaaS dependency.
- **Not a multi-tenant platform** — single-tenant by design; isolation is per-process, not per-user.
