# ADR 0011 — Pi cockpit launch topology + native-peer `/events` firehose

**Status**: Proposed (2026-06-11) — extends ADR 0010, pi launch lane (hostname-null-claude-0)
**Deciders**: hostname-null-claude-0 (implementation owner); reviewers: cognee-codex, dot-proxmox
**Affects**: `@agents-js/cli` (`launch.ts`, `cli.ts`, `client/command.ts`, new `run-logged.ts`),
`@agents-js/agent-launch` (`config.ts`, `plan.ts`, `tmux-windows.ts` — doc only), `@agents-js/pi-extension`
(`native-peer.ts`)
**Supersedes**: the `:0`=TUI / `:1`=runtime two-window layout of [ADR 0010](./0010-dual-window-pi-launch-topology.md)

---

## Context

ADR 0010 shipped a two-window launch (`:0` interactive TUI, `:1` pi runtime) gated by the
`dual_window` config flag. In use the layout had two gaps: attaching dropped you on the generic A2A
client rather than the agent you actually drive, and there was no in-session view of the protocol
traffic or the runtime's diagnostics. A native pi's embedded A2A server is also **request-scoped** —
agent-card + a JSON-RPC POST — so there was no way to passively watch the agent's event flow.

## Decision

1. **Window order flips; layout grows to a 4-window cockpit.** `dual_window: true` (name kept for
   back-compat) now opens:
   - `:0` **runtime** — the pi process; the **default landing window** on attach.
   - `:1` **tui** — `agents-js client --agent <name> --wait`.
   - `:2` **acp** — `agents-js client --agent <name> --wait --observe` (read-only raw event stream).
   - `:3` **logs** — `tail -F` of the runtime's captured stderr.
   Rationale: the thing you most want on attach is the agent itself, with the client/observer/logs as
   satellites. The layout is runtime-agnostic — `:0` runs whatever `plan.command` is, so it applies to
   ajs-fronted pi (`agents-js-gateway --runtime`) as well as native pi.

2. **Bun-native log tee (`agents-js run-logged`), not shell redirection.** A new
   `run-logged --log <path> -- <cmd…>` wraps the `:0` runtime: `Bun.spawn` with **stdin/stdout
   inherited** (the interactive TUI keeps the real TTY) and **stderr piped**, tee-ing each stderr chunk
   to both the live terminal and the logfile (`fs.appendFile`, append-mode, parent dir created). `:3`
   tails that file. stderr-only capture keeps the `:0` TUI rendering intact while giving a persistent,
   scrollable log.

3. **Native-peer `/events` firehose.** `native-peer.ts` gains a `GET /events` SSE route backed by an
   in-process broadcast hub. The executor's `ExecutionEventBus` is wrapped in a transparent `Proxy`
   (`teeEventBus`) whose only special trap is `publish` — it calls `hub.broadcast(event)` then delegates
   to the real bus, so per-task lifecycle is byte-for-byte unchanged and each event reaches the hub
   exactly once. The JSON-RPC POST + agent-card routes are untouched. This mirrors the gateway's
   existing `/events` bus, brought down to the native peer.

4. **`agents-js client --observe` is the read-only tap.** Non-interactive: resolves the target
   (`--agent`/`--url`/`--card`, honoring `--wait`), connects to `${base}/events`, and prints each raw
   `data:` frame to stdout. Mutually exclusive with `--message`/`--probe`.

5. **Wire format = the raw executor `AgentEvent`.** `/events` `data:` lines carry
   `JSON.stringify(<AgentEvent>)` — the SDK-internal event (numeric `status.state` enum, `kind`
   discriminator), NOT the encoded A2A JSON-RPC wire shape. "Raw" is taken literally: observers see the
   pre-transport truth. (Switching to the transport-encoded form later is a localized change in the tee.)

## Consequences

- Attaching a cockpit agent lands on the runtime; the client, a live protocol stream, and logs are one
  `tmux` window away each.
- New CLI surface: `agents-js run-logged` and `agents-js client --observe`. The native peer exposes a
  third route (`GET /events`) — a read endpoint, no new mutation surface.
- `dual_window` semantics changed without a config rename (back-compat); existing pi entries get the
  cockpit automatically on next launch.
- Tests: cockpit orchestration argv, `run-logged` tee/append/exit-code, `/events` tee delivery +
  subscriber cleanup, and `--observe` frame printing.

## Alternatives considered

- **Keep `:0`=TUI.** Rejected: you attach to drive the agent, not the generic client.
- **`:2` via `client --raw` (interactive).** Rejected: `--raw` is an interactive client with input; a
  cockpit observer should be passive. A true firehose needs the server-side bus.
- **Shell `2>> file` / `tee` for `:3`.** Rejected: not Bun-native, and process-substitution is shell
  -specific; `run-logged` keeps the tee in TypeScript and TTY-safe.
- **Broadcast the transport-encoded JSON-RPC frames.** Deferred: more faithful to "the A2A wire" but
  couples the hub to the transport encoder; raw events ship first, encoding is a later toggle.
