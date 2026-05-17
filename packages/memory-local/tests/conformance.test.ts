import { describe, expect, it } from "bun:test";
import { runProviderConformanceTests } from "@agents-js/memory/testing";
import { LocalMemoryProvider } from "../src/local-memory-provider.ts";
import { SqliteStorage } from "../src/sqlite-storage.ts";

/**
 * Drop the shared MemoryProvider conformance harness onto
 * LocalMemoryProvider × SqliteStorage(:memory:). Each test gets a
 * fresh in-memory sqlite db so cases don't share state.
 */
runProviderConformanceTests({
  describe,
  it,
  expect,
  makeProvider: () =>
    new LocalMemoryProvider({ storage: new SqliteStorage({ dbPath: ":memory:" }) }),
});
