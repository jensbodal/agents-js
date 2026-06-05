# Onboarding an agent with agents-js

This is the agents-js-side guide to taking an agent from a config entry to a
running participant on the mesh. It covers only the steps agents-js owns — the
CLI commands and the artifacts they produce. Fleet/identity provisioning
(Matrix users, gopass keys) and gateway/trust installation live in their own
systems; the boundary is spelled out under [Mesh-join boundary](#mesh-join-boundary).

## Two runtime modes

An agent runs in one of two modes. They are distinct operational profiles, not a
runtime toggle:

- **native** (`<host>-<harness>-<n>`, e.g. `malar-pi-0`) — the harness runs as
  *itself* (its own TUI/loop) and joins the mesh through a per-harness inbound
  transport. For `pi` that transport is the pi-extension, which binds a
  localhost A2A endpoint; the native agent is then an always-listening peer.
- **ajs-fronted** (`<host>-ajs-<harness>-<n>`, e.g. `malar-ajs-pi-0`) — the
  harness is launched **in ACP mode under the agents-js gateway**
  (`agents-js serve --harness <h>` / `agents-js-gateway --runtime <h>`), which
  fronts it over A2A. Headless; no interactive TUI.

Provisioning an agent's tools/skills/config is **orthogonal** to this choice —
it applies to both modes.

## Quick start — onboard a native pi

1. **Add a config entry** to an `agent-launch-config.json` (resolution order:
   `--config <path>` → `$AGENTS_JS_LAUNCH_CONFIG` →
   `~/.config/agents-js/agent-launch-config.json` → `./agent-launch-config.json`):

   ```json
   {
     "version": "0.1.0",
     "agents": {
       "malar-pi-0": {
         "tmux_session": "malar-pi-0",
         "harness": "pi",
         "binary": "pi",
         "workspace": "/path/to/workspace",
         "fresh_flags": "",
         "env_setup": "export MATRIX_AGENT=malar-pi-0",
         "pi_extension": "./extras/pi-extension/src/index.ts",
         "pi_port": "3197"
       }
     }
   }
   ```

   - `harness: "pi"` selects the native-peer launch.
   - `pi_extension` is what `pi -e <…>` loads (binds the A2A endpoint); defaults
     to `@agents-js/pi-extension`.
   - `pi_port` fixes the A2A port; omit it to let pi-extension pick an ephemeral
     port and self-register its URL in `~/.agents-js/registry.json`.
   - `MATRIX_AGENT` (via `env_setup`) becomes the agent's identity and its
     `AGENTS_JS_PI_NAME`.

2. **Onboard it:**

   ```sh
   agents-js onboard malar-pi-0 --bg
   # (agents-js launch malar-pi-0 --bg is the equivalent lower-level verb)
   ```

   This creates a detached tmux session running `pi -e <extension>` with the
   `AGENTS_JS_PI_*` env, so the native pi joins the mesh as an A2A peer.

3. **Confirm it's on the bus** — the endpoint serves an A2A agent card:

   ```sh
   curl -s http://127.0.0.1:3197/.well-known/agent-card.json
   ```

## Provision skills

Skills are authored once in a [skills-js](https://github.com/jensbodal/skills-js)
checkout and consumed by agents-js as a plain skills directory (agents-js never
imports skills-js). There are two delivery targets:

- **Harness-native install** (e.g. a Claude Code agent, or your own
  `~/.claude/skills`):

  ```sh
  agents-js skill install grill-me --from /path/to/skills-js
  # copies the resolved skill into ~/.claude/skills/grill-me (override with --into)
  ```

- **Skills-as-MCP** (for pi and any MCP-consuming harness): point
  `agents-js mcp` at a skills source and the skills surface in `tool_search`:

  ```sh
  export AGENTS_JS_SKILLS_DIR=/path/to/skills-js
  # a native pi's pi-extension spawns `agents-js mcp` in bridge mode and
  # discovers the provisioned skills (e.g. grill-me) via tool_search.
  ```

## Drive it from the terminal

Any agent reachable over A2A — native peer or gateway-fronted — can be driven
from the built-in terminal chat client:

```sh
agents-js client --url http://127.0.0.1:3197
```

The client is an A2A TUI; it works against any agents-js gateway or native
endpoint.

## Mesh-join boundary

agents-js **emits** the machine-readable mesh-join artifacts; it does not mutate
gateway/infra state. The split (confirmed across the fleet/infra owners):

| Owner | Responsibility |
| --- | --- |
| **agents-js CLI** | config entry, keypair, agent-card, harness-native skill/def, and the peer-record / mesh-join bundle (emit only) |
| **Matrix/bridge** | Matrix user registration + bridge routing roster |
| **Gateway infra** | install the emitted peer-record into the gateway trust manifest, then prove it with a challenge/redeem + send-with-inbox smoke |

> agents-js onboarding produces the mesh-join artifact; the gateway operator
> applies it and proves it with challenge/redeem plus a send-with-inbox smoke.

A future `--apply-infra` operator handoff may shell out to the infra apply step,
but it is not the default path.

## Not yet (tracked follow-ups)

- A dedicated `@agents-js/agent-profile` descriptor package that emits all
  surfaces from one source (today the config entry + the loader carry this).
- Idle-wake delivery (`@agents-js/wake-signal-store` + trigger publisher) for
  harnesses that can't hold a listening connection (claude/codex). An
  always-listening native pi does not need it.
- `agents-js launch`/`onboard` for additional harnesses beyond `claude-code`
  and `pi`.
