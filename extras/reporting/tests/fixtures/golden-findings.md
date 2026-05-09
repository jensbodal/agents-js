# Deterministic Findings Report

- Repo: @agents-js/root
- Commit: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
- Profile: agents-js
- Findings: 2
- Severity Counts: P0=0, P1=1, P2=1, P3=0
- Sources Snapshotted: 1

## Findings

### [P1] Session map race

Concurrent prompts can interleave shared mutable state.

- ID: f-abc
- Location: packages/a2a/src/executor.ts:35
- Confidence: 0.92
- Workers: runtime_worker
- Evidence: local:executor-35

### [P2] Stale path in docs

Documentation references app path that no longer exists.

- ID: f-def
- Location: mise.toml:6
- Confidence: 0.81
- Workers: config_docs_worker
- Evidence: local:mise-6

## Component Notes

- @agents-js/a2a: Executor bridges ACP sessions.

## Source Snapshot

- jsoncanvas_spec: https://jsoncanvas.org/spec/1.0/ (hash-jsoncanvas)
