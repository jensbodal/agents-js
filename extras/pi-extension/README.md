# @agents-js/pi-extension

Pi CLI extension for A2A agent communication.

## Quick Start

```bash
# Build the extension (bundles all deps for Node.js)
cd packages/pi-extension
bun run build

# Load in Pi CLI
pi -e ./dist/extension.js
```

## How It Works

The extension registers each A2A agent in `~/.agents-js/registry.json` as a Pi tool (`a2a_<name>`). When Pi's LLM invokes the tool, the extension dispatches via A2A to the remote agent and streams the response back.

On every prompt, the extension injects the available agents into context so the LLM knows they exist.

Native peer mode also exposes the live Pi TUI itself as a localhost A2A agent. That lets another Pi, `agents-js client`, or the web UI drive the same native Pi session over A2A.

## Two Entry Points

| Entry | Runtime | Use case |
|-------|---------|----------|
| `dist/extension.js` | Node.js (Pi CLI) | Production: fully bundled, zero external deps |
| `src/index.ts` | Bun (monorepo) | Development: uses workspace resolution, supports MCP bridge mode |

### Bun entry (development)

```bash
# Bridge mode (default): spawns `agents-js mcp` as subprocess
pi -e ./src/index.ts

# Direct mode: imports @agents-js/a2a-client in-process
AGENTS_JS_PI_MODE=direct pi -e ./src/index.ts
```

## Native Pi Peer Dispatch

Native mode is for demos and local workflows where the Pi TUI is the primary operator surface. Launch two native Pi processes from the repo root:

```sh
AGENTS_JS_PI_NATIVE=1 AGENTS_JS_PI_NAME=pi-a AGENTS_JS_PI_PORT=3101 pi -e ./extras/pi-extension/src/index.ts
AGENTS_JS_PI_NATIVE=1 AGENTS_JS_PI_NAME=pi-b AGENTS_JS_PI_PORT=3102 pi -e ./extras/pi-extension/src/index.ts
```

Each process starts a localhost A2A endpoint and writes its URL into `~/.agents-js/registry.json` under `AGENTS_JS_PI_NAME`. Existing `a2a_<name>` tool registration still works, so Pi's local model can call registered A2A agents as tools.

In Pi A, type:

```text
@pi-b review this plan in one sentence
@@pi-b answer directly: what is the smallest next step?
```

The single-`@` form dispatches to Pi B, injects Pi B's response as visible peer context, and then lets Pi A compose the final answer. The `@@` form dispatches the remaining text directly to Pi B, displays Pi B's answer in Pi A, and marks the input handled so Pi A's local model does not run.

Optional secondary drivers can connect to either native Pi endpoint:

```sh
agents-js client --url http://127.0.0.1:3101
agents-js client --url http://127.0.0.1:3102
```

Troubleshooting:

- If Pi reports a missing provider key or login, run `/login` in that Pi TUI or configure the provider environment Pi expects.
- If a port is already in use, change `AGENTS_JS_PI_PORT` for that process.
- If you want an isolated registry for a demo, set `AGENTS_JS_REGISTRY=/absolute/path/to/registry.json` on both launch commands.

### Threat model (native peer mode)

Native peer mode is intended for local/demo use only. It is not a hardened deployment target.

- The peer binds to `127.0.0.1` by default, but the A2A server returns `Access-Control-Allow-Origin: *` to match the rest of the repo's A2A convention. Any browser tab loaded over `http://127.0.0.1:*` can POST to the peer and trigger an LLM turn.
- The JSON-RPC endpoint has no authentication. Any process on the loopback interface can drive the live Pi TUI.
- Inbound A2A turns invoke `sendUserMessage` and bill against whichever provider the target Pi is logged into.
- Do not bind to `0.0.0.0`, and do not expose the port over a tunnel, proxy, or LAN. If network exposure is needed, gate it externally — mTLS, an SSH tunnel, or an authenticated reverse proxy.

### Node.js bundle (production)

```bash
bun run build   # creates dist/extension.js
pi -e ./dist/extension.js
```

The Node.js bundle always uses direct mode (in-process A2A). The MCP bridge mode requires `Bun.spawn` which isn't available in Node.js.

## Requirements

- Pi CLI (`npm install -g @mariozechner/pi-coding-agent`)
- `~/.agents-js/registry.json` with registered agents (`agents-js registry add <name> <url>`)
- At least one running A2A gateway (`agents-js serve` or `bun apps/internal-gateway/cli.ts`)
- An LLM provider configured in Pi (`/login` in the Pi TUI)

## Streaming

The direct client uses `stream: true` for A2A dispatch. Streaming events appear as:
- `message.delta` -> `{ type: "streaming", text }` (token-by-token response)
- `step.started` -> `{ type: "progress", text }` (dispatch status)
- CUSTOM `agents-js.a2ui.surface_event` -> `{ type: "a2ui", surfaceId, event }`

## A2UI Surface Events

When the gateway emits an AG-UI `CUSTOM` event named `agents-js.a2ui.surface_event` (see `@agents-js/a2ui-types` `A2UI_SURFACE_EVENT_NAME`), pi-extension forwards it through the same `onProgress` callback as `{ type: "a2ui", surfaceId, event }`. Pi itself has no TUI rendering for A2UI surfaces; this forwarding exists purely so downstream consumers — for example, a Pi plugin that knows how to render A2UI — can observe and display them. Interpretation of the `event` payload is out of scope for pi-extension.
