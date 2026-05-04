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
