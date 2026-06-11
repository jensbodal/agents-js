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

## Cockpit launch (runtime + tui + acp + logs)

A native pi can launch as an interactive agent *and* an A2A peer in one step.
Set `dual_window: true` on the pi config entry (name kept for back-compat); plain
`agents-js launch <name>` opens one tmux session with a four-window cockpit
(ADR 0011, extends ADR 0010):

- `:0` **runtime** — the native pi (its embedded A2A endpoint is the surface);
  the **default landing window** on attach.
- `:1` **tui** — `agents-js client --agent <name> --wait` (the chat client you
  drive; resolves the peer URL from `~/.agents-js/registry.json` by name and
  waits for health).
- `:2` **acp** — `agents-js client --agent <name> --wait --observe` — read-only
  raw **pre-transport agent-event** diagnostic stream tapped from the peer's
  `/events` firehose (the SDK's internal `AgentEvent`s, not the JSON-RPC wire shape).
- `:3` **logs** — `tail -F` of the runtime's captured stderr (the `:0` process is
  wrapped in `agents-js run-logged`, which tees stderr to a logfile without
  disturbing the interactive TTY).

`--bg` builds all windows and connects them without attaching. The runtime binds
the resolved LAN host (`AGENTS_JS_PI_HOST`); if the host's IP changes, the bound
socket points at the old address and the peer goes unreachable until you
**relaunch** so it re-binds.

> The launcher delivers each window's command via tmux `send-keys`, which feeds
> the shell in canonical mode (line input truncates at ~1024 bytes). The runtime
> startup is therefore sent as separate short lines — one `export` per env var,
> then the command — so a long `fresh_flags` can't be truncated mid-command.
> Still prefer the short session-resume forms below over a long absolute
> `--fork <path>`.

## Resume a prior session

pi persists each session as a JSONL transcript under
`~/.pi/agent/sessions/<workspace-slug>/`, keyed by the **workspace path**. To
bring a pi up on an existing session, add one of these to `fresh_flags`:

- `--continue` (`-c`) — resume the most recent session in the current workspace.
- `--session <path|id>` — resume a specific session file or partial UUID.
- `--fork <path|id>` — fork a session into a new one (keeps the original).

To resume a session that was recorded in a **different** workspace (e.g. moving
an agent into its own dedicated workspace), copy that session's JSONL into the
new workspace's `sessions/<slug>/` directory and launch with `--continue` — this
avoids a long absolute `--fork` path that the `send-keys` limit above can
truncate. Confirm the resume took by checking the runtime's context-usage
indicator is non-trivial (a blank session starts near 0%).

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

### Native-only vs full signed peer

A native pi runs in one of two states. The first is fully self-serve; the second
layers on three items agents-js **cannot self-mint** — they are provisioned by
the fleet/operator:

| State | Capabilities | What it needs |
| --- | --- | --- |
| **native-only** | interactive TUI + local A2A peer (registry-routable on this host) | config entry, workspace, definition, port — self-serve |
| **full signed peer** | the above **plus** cross-host dispatch, signed gateway inbox, and Matrix participation | the three items below |

1. **Matrix account** `<agent>@<homeserver>` + access token (Matrix/bridge owner).
2. **Gateway signing keypair** in the secret store at
   `services/agents-js/identity/<agent>/{key,pubkey}` (gateway-mint). The entry's
   `channel_env` `CH_GATEWAY_KEY_CMD` reads the private key at runtime.
3. **Trust-manifest peer-record install** at the gateway — identity + pubkey +
   the dispatch `{kind:"a2a", url}`. `agents-js onboard` emits the dispatch entry
   (requires a fixed `pi_port` + a resolvable advertise host); the gateway
   operator installs it.

A `channel_env` export only defines the key-read **command** — it does not run
it — so an agent launches cleanly in native-only mode before the keypair exists.
Items (1) and (2) let the agent **hold and sign with its own identity** while
still native-only; item (3) — the gateway trust-manifest peer-record install —
is what makes the gateway trust it and cross-host-route to it. It becomes a full
signed peer only once **(1), (2), and (3)** are provisioned (relaunch to pick up
the keypair).

## Not yet (tracked follow-ups)

- A dedicated `@agents-js/agent-profile` descriptor package that emits all
  surfaces from one source (today the config entry + the loader carry this).
- Idle-wake delivery (`@agents-js/wake-signal-store` + trigger publisher) for
  harnesses that can't hold a listening connection (claude/codex). An
  always-listening native pi does not need it.
- `agents-js launch`/`onboard` for additional harnesses beyond `claude-code`
  and `pi`.
- A baseline provisioning profile for `agents-js onboard` that can install the
  configured harness-native skills, write the `AGENTS_JS_SKILLS_DIR` MCP
  discovery wiring, run/write `agents-js mcp setup`, and bootstrap common built-in
  tool discovery where a harness requires explicit registration.
