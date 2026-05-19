<!-- This README is hand-maintained. -->

# @agents-js/memory-postgres

PostgreSQL `Storage` backend for the agents-js `MemoryProvider`.

Plugs into [`@agents-js/memory-local`](../memory-local)'s `LocalMemoryProvider` via the public `Storage` seam to back agent memory with durable Postgres storage instead of local sqlite.

## Status

Implements the `Storage` contract from `@agents-js/memory-local` including the substrate read primitives added in [ADR 0001](../../docs/adrs/0001-memory-provider-substrate-read-primitives.md):

- `insertRecord` / `updateRecord` / `getRecord` / `deleteRecord` / `findByIdempotency` / `close`
- `listByScope` substrate-read primitive with cursor-based pagination (`id > $cursor` pattern, `ORDER BY id ASC`, over-fetch-by-one for `hasNext` detection)

## Why not sqlite?

`@agents-js/memory-local` ships `SqliteStorage` for single-process Bun runtimes. Use `PostgresStorage` when:

- Multiple processes (or hosts) share one memory store
- Memory needs to survive single-process restart at scale
- You want centralized backup / replication / observability via your existing Postgres ops

## Usage

```typescript
import { LocalMemoryProvider } from "@agents-js/memory-local";
import { PostgresStorage } from "@agents-js/memory-postgres";

const storage = new PostgresStorage({
  connectionString: process.env.POSTGRES_URL!,
  // Optional: pick a schema namespace so multiple memory stores coexist
  schemaName: "agents_js_memory",
});

const provider = new LocalMemoryProvider({ storage });

// Use provider exactly as you would with SqliteStorage
const record = await provider.saveMemory(actor, {
  scope: { kind: "agent", agentId: "demo" },
  type: "feedback",
  content: "Hello postgres",
});
```

## Schema

Tables live in a caller-chosen schema (default `agents_js_memory`). The schema is created lazily on first call.

```sql
CREATE TABLE <schema>.records (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  revision INTEGER NOT NULL,
  creator_kind TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  idempotency_key TEXT
);

CREATE UNIQUE INDEX idx_records_idempotency
  ON <schema>.records (creator_kind, creator_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX idx_records_scope_id
  ON <schema>.records (scope_kind, scope_key, id);
```

The `(scope_kind, scope_key, id)` composite index supports `listByScope`'s cursor-based pagination efficiently — Postgres performs an index-only scan from the cursor position.

## Connection pooling

Uses the [`postgres`](https://github.com/porsager/postgres) client. Default pool size is `max: 4` (appropriate for memory-store workloads which are bursty but not high-concurrency). Override via `clientOptions`:

```typescript
new PostgresStorage({
  connectionString: "...",
  clientOptions: { max: 16, idle_timeout: 30 },
});
```

## Tests

Tests require a reachable Postgres instance. Set `POSTGRES_TEST_URL` to a writable database (the test suite uses an ephemeral schema per run and drops it on teardown).

```bash
export POSTGRES_TEST_URL='postgres://cognee:cognee@localhost:54321/cognee'
bun test
```

## License

MIT — see repo root.
