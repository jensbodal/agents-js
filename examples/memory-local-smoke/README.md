# @agents-js/example-memory-local-smoke

Smoke example for [`@agents-js/memory-local`](../../packages/memory-local).

Demonstrates:

- Constructing a `LocalMemoryProvider` with a custom `MemoryPolicyGate`.
- The pre-storage gate seam: a `deny` decision lifts to `MemoryAclError`
  before any storage write touches sqlite.
- A full save / update / delete round-trip against an on-disk sqlite
  database wired through `bun:sqlite` (the runtime built-in; no npm
  dependency).

## Run

```bash
bun run --cwd examples/memory-local-smoke smoke
```

## Test

```bash
bun run --cwd examples/memory-local-smoke test
```

## Layout

```
examples/memory-local-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json
  src/smoke.ts          # CLI: gate-denial demo + round-trip
  tests/smoke.test.ts   # deny-path + round-trip assertions
  README.md             # this file
```
