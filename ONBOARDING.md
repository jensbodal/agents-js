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

For the common internal case, this should be enough:

```sh
agents-js generate-config --name olthoi0-pi-jensbodal --harness pi
agents-js onboard olthoi0-pi-jensbodal
```

For a strictly local validation run before cross-host dispatch/trust provisioning,
pin the advertised host to loopback:

```sh
agents-js generate-config --name olthoi0-pi-jensbodal --harness pi --pi-host 127.0.0.1
agents-js onboard olthoi0-pi-jensbodal
```

That creates a local native Pi identity workspace at
`~/workspaces/agents/olthoi0-pi-jensbodal`, starts the runtime cockpit, and
registers the peer in the local agents-js registry. Local-only means the peer is
drivable from this host through the cockpit and local registry; it is not signed
into a federated gateway, not Matrix-provisioned, and not a stable cross-host
dispatch target unless you also configure a fixed `pi_port` plus gateway trust.

1. **Generate the config entry** in the default launch-visible user config:

   ```sh
   agents-js generate-config --name olthoi0-pi-jensbodal --harness pi
   ```

   This updates the same user config path `agents-js onboard` will read:
   `$AGENTS_JS_LAUNCH_CONFIG`, then `$XDG_CONFIG_HOME/agents-js/agent-launch-config.json`,
   then `~/.config/agents-js/agent-launch-config.json`. For a Pi agent it infers:

   - `workspace: ~/workspaces/agents/<name>`
   - `env_setup: export MATRIX_AGENT=<name>`
   - `fresh_flags: --approve`
   - `cockpit: true`

   Use `--workspace`, `--matrix-agent`, or `--fresh-flags` to override those
   defaults. Use `--pi-host 127.0.0.1` when validating a loopback-only local
   peer, and use `--stdout` when you want JSON only and no file writes.

2. **Onboard it:**

   ```sh
   agents-js onboard olthoi0-pi-jensbodal
   ```

   Onboard creates the missing workspace, initializes git if needed, and seeds
   `README.md`, `HANDOFF.md`, and `.agents/<name>/identity.md` before launching.
   This is an identity workspace for the native Pi agent; sandboxed source-repo
   editing is a separate integration, not implied by onboarding.

   The launch runs `pi -e <extension>` with the `AGENTS_JS_PI_*` env, so the
   native pi joins the mesh as an A2A peer.

3. **Drive the cockpit locally.** `onboard` launches the tmux cockpit for the
   agent. If it is not already attached, attach to it:

   ```sh
   tmux attach -t olthoi0-pi-jensbodal
   ```

   Use window `:1` (`tui`) to talk to the agent through
   `agents-js client --agent <name> --wait`. A connected card view means the A2A
   peer is reachable; type a small prompt and press Enter to confirm the native
   Pi runtime responds. Window `:0` is the Pi runtime, `:2` is the read-only ACP
   event observer, and `:3` tails runtime logs.

4. **Confirm it's on the bus** — the endpoint serves an A2A agent card. If you
   configured `--pi-port 3197`, for example:

   ```sh
   curl -s http://127.0.0.1:3197/.well-known/agent-card.json
   ```

   For an ephemeral local port, use the generated client probe instead:

   ```sh
   agents-js client --agent olthoi0-pi-jensbodal --probe
   ```

Local onboarding is complete when the cockpit is running, the `:1` client is
connected, a test prompt gets a response, and `agents-js client --agent <name>
--probe` returns successful A2A card/CORS checks. Gateway dispatch and signed
cross-host identity are follow-up provisioning, not part of this local-only
completion bar.

### Cleaning up temporary pi agents

If you tested with temporary names such as `olthoi0-pi-jensbodal-tmp-1`, clean up
only the temporary artifacts after the real agent works:

```sh
tmux kill-session -t olthoi0-pi-jensbodal-tmp-1
agents-js registry remove olthoi0-pi-jensbodal-tmp-1
```

Then remove the temporary entry from
`~/.config/agents-js/agent-launch-config.json`. Remove the temporary workspace
under `~/workspaces/agents/<tmp-name>` only after confirming it contains no
handoff notes or local state you need. Do not remove the real
`~/workspaces/agents/olthoi0-pi-jensbodal` workspace as part of temp cleanup.

## Cockpit launch (runtime + tui + acp + logs)

A native pi can launch as an interactive agent *and* an A2A peer in one step.
Generated Pi entries set `cockpit: true`; plain `agents-js launch <name>` opens
one tmux session with a four-window cockpit (ADR 0011, extends ADR 0010):

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

## Unattended restart (trust persistence)

A self-exposing harness that prompts for a one-time trust grant on first launch
will **hang on that interactive prompt when restarted unattended** (idle-wake,
crash recovery, scheduled relaunch) — there is no human present to approve it.
Two complementary mechanisms keep unattended restart from wedging; keep **both**
(defense-in-depth — do not drop the safety net once trust-persist is the default):

1. **Structural fix — auto-approve + persisted trust.** For `pi`, put `--approve`
   in the agent's `fresh_flags`. `--approve` runs pi in non-interactive trust
   mode: it auto-grants trust on first run **and writes** the grant to
   `~/.pi/agent/trust.json` — a JSON map of trusted workspace roots → `true`
   (e.g. `{"/path/to/workspace": true}`) that pi reads at startup to skip the
   prompt thereafter. Because `--approve` writes the trust file itself, **the
   file need not pre-exist**. The trusted root must equal the directory pi
   launches in (the agent's workspace root).

   ```json
   "fresh_flags": "--approve"
   ```

   Belt-and-suspenders (what the proven canary runs): **both** `--approve` in
   `fresh_flags` **and** a pre-seeded `~/.pi/agent/trust.json` keyed to the
   workspace root, so an unattended restart never blocks even on the very first
   run. Verified live on a pi canary (2026-06-10).

2. **Safety net — probe-abort + retry-until-budget.** For harnesses that do
   **not** persist trust (or where a prompt can still surface), the launcher's
   readiness probe aborts a hung start and retries until a budget is exhausted
   (the `#181` probe-abort path), so one bad start does not wedge the agent. This
   remains the backstop even after trust-persist is the default: it covers the
   non-persisting case and any regression in the structural fix.

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
