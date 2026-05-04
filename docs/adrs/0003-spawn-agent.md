# ADR 0003: spawnAgent — agent-callable subagent dispatch primitive

**Date:** 2026-04-22
**Status:** Accepted
**Author:** cognee-claude
**Reviewers:** omd-orchestrator (tools-owner), dot-proxmox (gateway/infra)

## Context

Agents running in agents-js need a way to delegate a bounded subtask to a fresh subagent mid-flow, without abandoning their main context. Inspired by Zed's `spawn_agent` tool (shipped in Zed 0.233.2), which exposes subagent dispatch as a callable tool to the running agent. Prior art in agents-js: subagent dispatch happened only at the orchestrator layer (Task tool in Claude Code harnesses, Haiku dispatch in skills-js). No first-class agents-js primitive that an agent could call from within its own flow.

This ADR covers the design of `spawnAgent` in `@agents-js/tools` + the gateway-layer primitive `spawnSubSession` in `@agents-js/gateway-runtime` that it wraps.

## Decision

Ship a two-layer primitive:

1. **Gateway layer** (`@agents-js/gateway-runtime` `spawnSubSession`): owns the ACP process spawn, session handshake, prompt, terminal-summary collection, and lifecycle cleanup. Exposes a pure-value result shape; all side-effects (subprocess creation, termination) are internal.
2. **Tool layer** (`@agents-js/tools` `spawnAgent`): wraps the gateway with agents-js/tools concerns — provenance tagging, optional `TraceEmitter` parent/root threading, self-spawn depth enforcement, registry registration under the `"SpawnAgent"` capability name.

### v1 scope (bounded-mode + trial-agent only)

- **Bounded mode only.** Detached mode + polling handle ships in a follow-on commit.
- **Trial-agent harness only** in the gateway's supported-harness allow-list. Explicit `hints.harness != "trial"` returns `status: "harness_unavailable"` without silent fallback — the caller asked for a specific execution boundary; silently running somewhere else would be lying about where the work ran.
- **Self-spawn depth limit** enforced at the tool-layer entry (default `maxDepth = 1`). `depth >= maxDepth` → `status: "depth_limit_exceeded"` without reaching the gateway.
- **No worktree isolation in v1.** The `hints.worktree_isolation` option is accepted in the shape for forward-compatibility but currently ignored.
- **No cross-host spawning.** Subagent always runs on the same host as the parent.
- **No receipt/commitReceipt on v1 API surface.** Ships as a follow-on when the inbox primitive's `commitReceipt(token, {integrated | aborted})` lands.

### Naming convention

| Surface | Name |
|---|---|
| Tool name (registry string, agent-facing) | `"SpawnAgent"` (PascalCase capability) |
| SDK function export (TS) | `spawnAgent()` (camelCase per TS idiom) |
| REST endpoint (future) | `POST /tools/spawn-agent` (kebab-case) |
| MCP tool | `spawn_agent` (matches Zed convention for cross-ecosystem familiarity) |

Convention lock: TS SDK exports are camelCase going forward. PascalCase is reserved for the tool-name string in the registry + docs (the capability label).

### Provenance

Completed spawn produces one `Source` carrying the harness + session_id via a structured URI scheme using the currently-shipped `source_type: "tool"`:

```
source_type: "tool"
source_ref:  "tool://spawn-agent/<harness>/<session_id>"
observed_at: <ISO 8601 timestamp>
retrieved_at: <ISO 8601 timestamp>
confidence:  "responsible"
```

Migration path: when the substrate-neutral source shape lands (`source_type` / `source_substrate` two-field), spawnAgent migrates to `source_type: "subagent"` + `source_substrate: <harness>`. Not a v1 blocker — the URI-encoded form carries the same information.

### Trace integration

When callers supply a `TraceEmitter`, spawnAgent records one `ToolCallTrace` event (tool_name `"SpawnAgent"`). The emitted record's `event_id` becomes the composition root for any nested traces a subagent produces. Subagents that don't emit their own traces (trial-agent in v1) leave the parent record standing alone.

Secret handling: the emitted trace carries `args = {subtask, hints, depth, maxDepth}` with no default redaction. `subtask` content may carry secrets if the parent's context included tokens/credentials. Consumers wiring SpawnAgent in secret-carrying contexts must either provide a `RedactionSpec` when registering the tool (per-tool redaction via the `ToolDefinition.redaction` seam) or bypass the tool layer by calling the SDK function directly. Core ships zero default redactors — consumers configure policy.

## Alternatives considered

**Alternative 1: orchestrator-only subagent dispatch.** Keep subagent dispatch as an orchestrator concern (Task-tool pattern in Claude Code harnesses); don't expose it as an agent-callable tool. **Rejected:** Zed's spawn_agent pattern demonstrates value in letting the agent decide mid-flow when to fan out. Orchestrator-only dispatch forces the human or meta-layer to pre-decide, losing responsiveness to in-flight context.

**Alternative 2: single-commit cross-package implementation.** Ship gateway-layer `spawnSubSession` + tool-layer `spawnAgent` in one commit touching both packages. **Rejected:** larger review surface; less isolated test coverage. Chose sequential (gateway first, then tools) so each layer's invariants can be independently validated.

**Alternative 3: allow silent harness fallback.** If `hints.harness` is unavailable, fall back to default with a warning. **Rejected** (per dot-proxmox review): caller asked for a specific execution boundary; silently running elsewhere is lying about where the work ran. Explicit fail-closed is correct.

**Alternative 4: ship receipt/commitReceipt on v1 surface with "not yet implemented" status.** **Rejected** (per dot-proxmox review): creates a fake guarantee in the API contract. Receipt pattern ships when the inbox primitive lands.

**Alternative 5: bake self-spawn depth enforcement into gateway layer.** **Rejected:** gateway layer doesn't introspect the parent chain; tool-layer owns depth tracking via explicit `parent_session_id`. Gateway stays agnostic.

## Consequences

### Accepted trade-offs

- **Double entry point (tool + SDK).** The `spawnAgent()` SDK function and the `"SpawnAgent"` tool-registry entry have overlapping shapes. Intentional — they serve different consumers (TS code vs agent-facing tool-call surface). The registry entry flat-deconstructs `{subtask, ...options}` from a single arg bag to match MCP tool-call conventions.
- **Depth limit of 1 by default.** Conservative; permits only a single spawn from human-initiated sessions. Configurable per-call via `maxDepth`. Will revisit when a self-spawning harness lands with cost/loop telemetry.
- **Trial-agent as the only supported harness in v1.** Expands as harnesses land hardening gates for subagent spawning. Each new harness addition is a review gate, not an automatic include.

### Readiness gates (v1 bounded + trial-agent)

These are work-path gates, not build-pass gates. SpawnAgent is "done" only when all of these pass:

1. Bounded: spawn a subagent for a trivial subtask (`"what is 2+2"`), verify `summary` returns with `status: "completed"` within timeout and `duration_ms` populated.
2. Explicit-harness selection: spawn with `hints.harness: "trial"`, verify the session actually runs trial-agent (observable via process tree / session metadata).
3. Harness fail-closed: spawn with `hints.harness: "nonexistent"`, verify `status: "harness_unavailable"` without silent fallback.
4. Provenance: returned source carries `source_type: "tool"` and structured `source_ref` (`tool://spawn-agent/<harness>/<session_id>`).
5. Parent tracing via TraceEmitter: memory-sink the parent's emitter + verify a single `SpawnAgent` trace record is emitted; the record's `event_id` is threadable into a child's `TraceEmitter` as `rootEventId` + `parentEventId`.
6. Self-spawn depth enforcement: spawnAgent-from-trial-agent respects `maxDepth`; deeper spawns fail closed with `gateway/spawn-depth-exceeded`.

### Follow-on gates

- Detached mode: spawn with `mode: "detached"`, get a handle, poll status, confirm terminal transition.
- Cancel: spawn in detached mode, cancel the handle, verify subagent process terminated cleanly.
- Worktree isolation: spawn with `hints.worktree_isolation: true`, verify a fresh git worktree is created + cleaned up on session close.
- Receipt/commitReceipt: once inbox primitive ships, spawn a side-effect-producing subtask, verify receipt token returned + commitReceipt finalizes vs aborts.
- Parent-end-cancels-child: parent session termination propagates to in-flight detached children.

## References

- Implementation commits: `547be05` (gateway spawnSubSession), `ebd4308` (handshake-timeout + kill-safety hardening), `01c573d` (tools spawnAgent wrapper, amended to `64c3ca1` with input validation + trace-secrecy caveat).
- Related ADR: [0002 — FetchContext + findTools](./0002-fetch-context-and-tool-discovery.md) — the primitives spawnAgent composes alongside in `@agents-js/tools`.
- Zed's `spawn_agent` feature: shipped Zed 0.233.2 (2026-04-18) as a built-in tool callable by the running agent.
