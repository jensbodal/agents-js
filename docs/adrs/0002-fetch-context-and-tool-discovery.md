# ADR 0002: FetchContext Coordinator and findTools Discovery Surface

**Date:** 2026-04-21
**Status:** Proposed
**Author:** Jens Bodal

---

## Context

Agents currently see two degenerate shapes of tool-and-context exposure:

1. **Wall-of-tool-JSON.** Every connected tool schema is injected into every
   prompt. Cost scales with the registry, not with the query, and the model
   must pick through irrelevant options even for trivial requests.
2. **Implicit memory.** Prior decisions, room history, and hub docs are
   available only via whichever tool the caller happens to remember to wire
   in. There is no consistent recall verb and no provenance schema, so the
   agent cannot tell a canonical source from a corroborating note.

Two orthogonal problems, one shared root cause: the surface an agent
actually needs per turn is narrow, but the surface it sees is wide. The
first-cycle execution plan (`hub/agents-js/plans/first-week-plan-2026-04-21-final.md`,
locked by jensbodal 2026-04-21) introduces two verbs — a memory-recall
coordinator and a tool-discovery scanner — and ships them behind a single
package boundary so they can share a registry and a provenance schema.

The plan also constrains the v1 implementation: in-memory only, no chat-room
trace sink, no external dependencies beyond the workspace, no machine-learning
scorer, and no production-agent exposure until a trial-agent isolation test
has passed. Cognee-backed semantic recall is held on dot-proxmox backlog
item BL-49 and is explicitly excluded from the first commit.

---

## Decision

Ship one new package — `@agents-js/tools` — with two externally-visible
verbs and one provenance schema.

### Shape 1 — `FetchContext` (coordinator)

```ts
async function FetchContext(
  query: string,
  options?: FetchContextOptions,
): Promise<FetchContextResult>;
```

`FetchContext` is a coordinator: it picks memory primitives based on
transparent query-shape heuristics, runs them (in parallel when the router
picks `"both"`), merges their results, prunes orphan sources, and returns
a ranked top-N. Callers may override the router's choice with an explicit
`hint` and may override `workspaceRoot` / `hubRoot` for tests.

### Shape 2 — `findTools` (discovery surface)

```ts
async function findTools(
  query: string,
  options?: FindToolsOptions,
): Promise<ToolDefinition[]>;
```

`findTools` is a discovery surface: it queries an in-memory registry and
returns up to `limit` tools (default 3) ranked by keyword overlap against
each tool's description and keyword list. The agent sees a narrow relevant
subset per turn rather than the entire wall-of-JSON.

### Provenance schema (canonical)

Every source returned by `FetchContext` carries five fields:

| field | purpose |
|---|---|
| `source_type` | discriminator: `matrix`, `hub-file`, `agent-msg`, `cognee`, `web`, `tool` |
| `source_ref` | stable identifier (path, event ID, mailbox ID, graph node ID, URL, tool name) |
| `observed_at` | ISO 8601 — source-side observation timestamp (file mtime, event origin) |
| `retrieved_at` | ISO 8601 — when this query read the source |
| `confidence` | `responsible` (canonical) vs `supporting` (corroborating) |

The `confidence` field distinguishes **responsible** sources — the current,
canonical source of truth for a datum (a hub markdown file, an agent memory
note written by the user) — from **supporting** sources — corroborating
context that may be stale, derivative, or secondary. Callers that need
authoritative answers filter to `responsible`; callers that want breadth
include both. dot-proxmox's Round 1 framing required this distinction
explicitly and it is preserved here without renaming.

### Self-hosting proof

The two memory primitives shipped with the first commit — `searchMemories`
and `searchDocs` — auto-register as tools in the default registry at module
load time. Calling `findTools("search the hub vault for X")` returns
`searchDocs` without additional wiring. This closes the loop: the discovery
surface knows about the recall primitives the same way it will know about
any future third-party tool.

### Deferred primitives

The plan calls for five memory primitives total:

- **Included in first commit:** `searchMemories`, `searchDocs`.
- **Deferred to iterative commits:** `searchRoomHistory` (Matrix timeline
  read), `searchAgentMsg` (agent mailbox), `searchWeb` (browser-safe
  `fetch` wrapper), `searchCognee` (semantic graph recall).

`searchCognee` is specifically gated on dot-proxmox backlog item **BL-49**;
it does not land in this package until the dot-proxmox Cognee service is
online and the readiness-gate isolation test has passed against it. The
remaining deferred primitives land on their own schedule — each is a small
commit on its own branch with its own tests, not a big-bang rewrite.

### No chat-room trace sink

Earlier drafts considered emitting a trace line to a Matrix room for every
`FetchContext` call. This would leak search queries (and by proxy, agent
reasoning state) into a multi-user channel. The first commit writes to an
append-only local log only — a file-backed sink is a downstream concern,
not part of the v1 primitive.

### No ML scoring

The router is deliberately transparent string matching (tokenize on
non-word characters, score against keyword sets and description tokens).
If heuristics ever need to grow beyond keyword matching, the remedy is to
expose a pluggable scorer interface — not to reach for an embeddings
model. The point of Shape 2 is that agents can predict the router's
behavior by reading one file.

---

## Consequences

### Accepted trade-offs

- **Filesystem I/O on every FetchContext call.** No cache in v1. This is
  fine for workspace-sized inputs; it will need revisiting when
  `searchDocs` is pointed at a much larger corpus or when the
  hub-vault tree grows beyond the "walk every file" budget.
- **In-memory registry only.** A process restart loses registered tools.
  Consumers who want persistence wrap their own loader around
  `createRegistry`.
- **Two verbs ship together.** The Shape 1 coordinator and Shape 2
  discovery surface are bundled in one package even though their runtime
  surfaces are largely independent. This is a deliberate cohesion choice:
  both verbs share the provenance schema, and the self-hosting proof
  only works when registering a tool and running a primitive are the same
  import surface.

### Readiness gates

Production-agent exposure (routing real agent prompts through `FetchContext`
by default) is **gated on the trial-agent ephemeral-ACP isolation test**
passing. That test lives in a separate task (#52 onward); merging this
commit to `main` does not flip the default.

The source-vs-worktree version contract for the skills-js plugin also
means this package is invisible to running orchestrator sessions until
the merge-to-main ceremony for `agents-js` has completed and the
orchestrator has been restarted.

### References

- First-cycle plan: `hub/agents-js/plans/first-week-plan-2026-04-21-final.md`
- Related package surface: [Primitives → Tool Surface](../primitives.md#tool-surface---agents-jstools)
- Deferred-primitive tracker: dot-proxmox BL-49 (Cognee)
