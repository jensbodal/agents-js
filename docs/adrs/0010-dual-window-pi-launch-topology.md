# ADR 0010 — Dual-window in-session topology for native-pi launch

**Status**: Proposed (2026-06-09) — pi dual-window lane, delegated to hostname-null-claude-0 by Jens
**Deciders**: hostname-null-claude-0 (implementation owner); reviewers: cognee-codex, olthoi0-codex-0
**Affects**: `@agents-js/agent-launch` (`config.ts`, `plan.ts`, `tmux-windows.ts`), `@agents-js/cli` (`launch.ts`, `client/command.ts`, `client/agent-resolve.ts`)

---

## Context

A native pi agent is both a backend mesh peer (its `@agents-js/pi-extension` binds an embedded A2A
HTTP server — that endpoint IS its ACP/A2A surface) and an interactive agent a human drives via the
`agents-js client` TUI. `agents-js launch <pi>` today opens only the backend in a single detached
tmux session with manual `tmux attach`. The goal: one command opens the TUI in tmux window `:0`
(auto-connected) and the pi runtime in `:1`, config-driven, with no per-host scripts or hardcoded
hostnames.

PR #176 (`--with-receiver`, codex) established a precedent for a *second* process at launch — but as a
**companion tmux SESSION** (`<name>-receiver`), purely as CLI orchestration in `launch.ts`; it did NOT
extend the session-level `TmuxRunner`.

## Decision

1. **In-session windows, not a companion session.** The pi TUI (`:0`) and runtime (`:1`) live in ONE
   tmux session. This differs deliberately from #176's companion-SESSION receiver: the two surfaces
   are one agent the user drives together, so they belong in one attachable session. (The pi runtime
   is both ACP and A2A — there is no separate gateway process to host.)

2. **Config-driven trigger (`dual_window`), not a CLI mode/flag.** The behavior is declared on the
   agent's launch-config entry (`dual_window: true`), so `agents-js launch <name>` "just works" and the
   intent travels with the agent definition. `LaunchMode` stays the fresh/resume axis; dual-window is
   orchestration, carried as a boolean on `LaunchPlan`. pi-harness only (rejected at plan build
   otherwise) — other harnesses expose no self-registered A2A endpoint to auto-connect to.

3. **Registry name-based resolution + readiness-on-connect.** The runtime's url may be ephemeral, so
   the TUI resolves it from `~/.agents-js/registry.json` by NAME at connect time via the new
   `agents-js client --agent <name> --wait` (mirrors `send.ts`'s registry lookup, but by name). `--wait`
   polls until the record appears AND its `health_check_url` returns 2xx, eliminating the
   TUI-before-runtime-bound race.

4. **`base-index` normalization.** The operator's tmux may set `base-index 1`, so the launcher detects
   the first window index and moves it to `:0` — never assuming `:0` pre-exists.

5. **Window ops are a composable seam; `TmuxRunner` stays session-level.** New
   `agent-launch/src/tmux-windows.ts` (`createTmuxWindowOps`) adds `newWindow` / `selectWindow` /
   `sendKeysToWindow` / `normalizeFirstWindowToZero` / `attachOrSwitch` reusing the same injectable
   `TmuxSpawner`. `tmux.ts` is unchanged, per the #176 boundary.

6. **Secrets routing unchanged.** Identity vars go through `set-environment`; `channel_env` secrets ride
   the send-keys export only — same contract as the single-window launch. `AGENTS_GATEWAY_HUMAN_URL`
   stays the canonical gateway-url signpost; this lane adds no startup-banner changes.

## Consequences

- One reviewable feature on three commits: window-ops seam → `client --agent/--wait` → `dual_window`
  launch wiring + auto-attach. Each lands behind learning/regression tests (LT-1..LT-11; LT-12 gated
  e2e).
- `agents-js client` gains a registry-resolution path it lacked (previously `--url`/`--card` only).
- Foreground launch now auto-attaches for dual-window agents (single-window behavior is unchanged).
- Not an AJS-141 phase: this builds on the stable Phase-1 + pi-native foundation as a distinct lane.

## Alternatives considered

- **Companion session (mirror #176).** Rejected: two windows the user tabs between in one session match
  the "one agent, two surfaces" mental model better than two sessions.
- **A `--dual`/`--tui` CLI flag or a `LaunchMode "dual"`.** Rejected: the trigger belongs with the agent
  definition ("just update the launch config"), and a mode would pollute the pure plan builder with
  attach/orchestration semantics.
- **A launch-side wrapper that reads the registry then execs `client --url`.** Rejected in favor of a
  first-class `client --agent`, so resolution + readiness are reusable and testable in one place.
