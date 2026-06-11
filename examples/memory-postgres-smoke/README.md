# @agents-js/example-memory-postgres-smoke

Smoke example for [`@agents-js/memory-postgres`](../../packages/memory-postgres).
The Postgres mirror of [`memory-local-smoke`](../memory-local-smoke).

Demonstrates:

- Wiring `PostgresStorage` into `LocalMemoryProvider` via the public Storage
  seam, with a custom `MemoryPolicyGate`.
- The pre-storage gate seam: a `deny` decision lifts to `MemoryAclError`
  before any Postgres connection is opened or write attempted. This runs
  with no database present — the `postgres` driver is lazy, so the deny
  fires before the storage seam is touched.
- A full save / update / delete round-trip against a live Postgres, run
  when `POSTGRES_TEST_URL` (or `DATABASE_URL`) is set and **cleanly skipped**
  otherwise — never a fake pass.

## Run

```bash
# deny path only (no DB required):
bun run --cwd examples/memory-postgres-smoke smoke

# full round-trip (live Postgres):
POSTGRES_TEST_URL='postgres://user:pass@host:port/db' \
  bun run --cwd examples/memory-postgres-smoke smoke
```

## Test

```bash
# deny test runs; round-trip skips when no connection string is set:
bun run --cwd examples/memory-postgres-smoke test

# full suite against a live Postgres:
POSTGRES_TEST_URL='postgres://user:pass@host:port/db' \
  bun run --cwd examples/memory-postgres-smoke test
```

The live round-trip uses an ephemeral schema (`memory_postgres_smoke_<ts>_<rand>`)
dropped on teardown, so concurrent runs don't collide or leak.

## Layout

```
examples/memory-postgres-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json
  src/smoke.ts          # CLI: deny demo + (live) round-trip
  tests/smoke.test.ts   # always-on deny test + skip-if-absent round-trip
  README.md             # this file
```
