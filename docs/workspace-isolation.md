---
title: Workspace isolation
diataxis: reference
outline: [2, 3]
---

# Workspace isolation

When an agent has shell or filesystem access, letting it mutate the
canonical workspace directly is a trust-boundary risk. The
`WorkspaceIsolationProvider` primitive gives each agent a sandboxed
replica of the workspace, with the host owning write-back authority
through a separate gate. Agents produce reviewable change-sets; the
host decides whether to apply them.

## What it gives you

- **Replicas, not direct mutation** — agents work in a per-task copy
  of the workspace and never touch the source repo.
- **Reviewable change-sets** — `inspectReplica` reports what
  changed, what was added, what was deleted, and (critically) any
  symlinks the agent created that escape the replica root.
- **Protected-path detection** — `policy.protectedPaths` flags
  mutations to `.env*`, secrets files, or any other path the host
  treats as off-limits.
- **Host-owned sync-back** — the provider deliberately exposes no
  `syncBack` method. Apply-to-source goes through the host's
  permission engine
  (`packages/policy/src/permission-engine.ts`), keeping write
  authority separate from agent execution.

## When to use it

- Multi-agent workflows where agents have shell or `cp`/`rm` access.
- Trust boundary between an LLM-driven agent and a source repo you
  cannot afford to corrupt.
- Reviewable-PR-style workflows where the host wants a diff to show
  a human before merging an agent's changes.

You don't need this for read-only agents, for fully trusted internal
tooling, or for agents whose only writes go through a constrained
API.

## Quickstart

```ts
import { createCopiedReplicaBackend } from "@agents-js/host";

const backend = createCopiedReplicaBackend();

const replica = await backend.createReplica({
  repoPath: "/abs/path/to/canonical/workspace",
  baseRef: "<git-sha-or-opaque-label>",
  taskId: "task-2026-05-23-001",
  agentId: "agent-1",
  policy: {
    excludePaths: ["dist", ".cache"],
    protectedPaths: [".env", ".env.local", "secrets/"],
  },
});

// Agent runs against replica.replicaPath ...

const inspection = await backend.inspectReplica({
  workspaceId: replica.workspaceId,
});

if (inspection.symlinks.some((s) => s.escapes)) {
  // Refuse to apply — the agent created a symlink reaching outside
  // the replica.
}

if (inspection.protectedPathMutations.length > 0) {
  // Refuse to apply — the agent touched a protected path.
}

const changeSet = await backend.exportChangeSet({
  workspaceId: replica.workspaceId,
  format: "summary",
});

// Hand `changeSet.content` to the host's review/apply gate.

await backend.destroy(replica.workspaceId);
```

## Provider contract

`WorkspaceIsolationProvider` is the seam every substrate implements.
Four methods, all explicitly bounded:

| Method             | Purpose                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `createReplica`    | Create a per-task replica under `replicaRoot/<workspaceId>/` and capture a content-hash baseline |
| `inspectReplica`   | Diff replica state against the baseline; surface symlink escapes + protected-path mutations      |
| `exportChangeSet`  | Produce a reviewable summary or path manifest (not a git-applyable patch — see [Change-set formats](#change-set-formats)) |
| `destroy`          | Clean up the replica directory and drop in-memory state                                          |

There is no `syncBack`. Apply-to-source is the host's responsibility,
not the provider's. The provider's job ends at producing a
reviewable change-set.

## CopiedReplicaBackend (v1 default substrate)

The v1 default ships `CopiedReplicaBackend`, which uses `fs.cp` to
copy the source tree (minus baseline exclusions) into a fresh replica
directory.

### Baseline exclusions

These are always excluded at copy time, regardless of policy:

- `.git` — Git metadata (hooks, config, refs, objects) is
  trust-sensitive. An agent with shell access could rewrite hooks,
  corrupt refs, or mutate object storage.
- `.jj` — Same reasoning for the Jujutsu VCS.
- `node_modules` — Excluded by default because copying it adds
  substantial latency and the agent can rerun `bun install` /
  `npm install` inside the replica if needed.

Operators can extend (but not narrow) this list via
`policy.excludePaths`.

### Why copied-replica, not git-worktree

A `GitWorktreeBackend` is on the v1.1 roadmap but does not ship in
v1. Git worktrees share Git metadata (hooks, config, refs, object
storage) with the canonical source repo. For a shell-capable agent,
that's a substantial trust-boundary leak — an agent could rewrite
the source repo's hooks, mutate refs, or corrupt object storage
through the worktree. A copied replica with `.git` excluded at
copy-time is the safer baseline.

### Symlink handling

Symlinks in the source are **followed** (resolved to their target's
content) during copy. The provider pre-validates the source tree
before copying — if any source symlink resolves to a path outside
the source root, the copy aborts atomically. Inside the replica,
agents may create new symlinks; `inspectReplica` reports any whose
realpath escapes the replica root with `escapes: true`. The host
write-gate should refuse to apply a change-set with escaping
symlinks.

### Replica location

Replicas live under `options.replicaRoot` (defaults to
`<os.tmpdir>/agents-js-replicas/`). The provider refuses to operate
if `replicaRoot` is misconfigured to live inside the source — better
to abort than risk recursive copy or in-tree replica pollution.

### State

Baseline content hashes and replica handles live in-memory on the
backend instance. They are **lost on process restart**. Per-task
ephemeral replicas (the v1 lifecycle pattern) make this acceptable
— for persistence across restarts, write your own provider on top
of durable storage and implement the same interface.

## Change-set formats

`exportChangeSet` ships two formats in v1; neither is git-applyable.

| Format            | Content                                                                                              | Use case                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `summary`         | Human-readable summary of modified/added/deleted paths with inline content for modified files        | Reviewer-facing display (e.g. show in a UI for a human to approve)                        |
| `rsync-manifest`  | Newline-separated list of mutated paths                                                              | Driving an rsync, a directory walk, or a follow-up patch generation that re-reads source  |

A v1.1 `unified-diff` format that is genuinely `git apply`-able is
planned. It requires retaining baseline bytes per file (not just
hashes) plus either a JS diff algorithm or a shell-out to `diff -u`.
Until that lands, do not pass `summary` content to `git apply` or
`patch -p1` — it isn't shaped for that.

## Limits and forward-looking

- **No git-applyable patch in v1** (see above).
- **No `syncBack` in the interface** — host owns write authority.
- **No `GitWorktreeBackend` in v1** — trust-boundary risk; on the
  v1.1 roadmap after constraint tests prove out.
- **No restart persistence in `CopiedReplicaBackend`** — per-task
  ephemeral lifecycle. Implement your own provider for durable
  state.
- **Container substrates (`DockerBackend`, `ProxmoxLXCBackend`)** —
  on the M2 roadmap. Reuse the same four-method interface without
  changing the seam.

## Related primitives

- [Permission engine](https://gitea.q4m.dev/jensbodal/agents-js/src/branch/main/packages/policy/src/permission-engine.ts)
  — host-side write-gate that consumes change-sets and decides
  whether to apply.
- [Federation peer-record signing & trust manifest](./federation/peer-record-signing-and-trust-manifest.md)
  — for the cross-host case, peer records also pass through a
  trust-boundary gate before their changes affect a federated
  workspace.
