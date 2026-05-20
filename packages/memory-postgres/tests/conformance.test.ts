import { afterAll, describe, expect, it } from "bun:test";
import { runProviderConformanceTests } from "@agents-js/memory/testing";
import { LocalMemoryProvider } from "@agents-js/memory-local";
import { PostgresStorage } from "../src/postgres-storage.ts";

/**
 * Conformance suite against PostgresStorage via LocalMemoryProvider.
 *
 * Per ADR 0001 acceptance criteria: new providers prove they satisfy
 * the FULL `MemoryProvider` contract by running `runProviderConformanceTests`,
 * not by hand-rolling a subset of tests. Future additions to the
 * conformance suite (e.g., the substrate-read strengthening pass added
 * in PR #31) automatically apply to PostgresStorage with this harness
 * invocation — without it, hand-rolled tests would drift over time.
 *
 * Each provider invocation gets a fresh ephemeral schema (timestamp +
 * random suffix) so concurrent test runs don't collide, and the schema
 * is dropped on teardown.
 *
 * Gated on `POSTGRES_TEST_URL` — skipped silently when unset to keep
 * the default `bun test` invocation green in environments without a
 * postgres instance.
 */
const POSTGRES_URL = process.env.POSTGRES_TEST_URL;

if (!POSTGRES_URL) {
  describe.skip("PostgresStorage conformance (POSTGRES_TEST_URL not set)", () => {
    it.skip("placeholder", () => {});
  });
} else {
  // The conformance harness owns the describe/it blocks; we just supply
  // the bun:test functions plus a factory that returns a fresh provider
  // backed by a fresh ephemeral schema per `makeProvider` call. We track
  // every minted storage so the module-scope `afterAll` can drop schemas
  // and close pools — without it, an N-test conformance run leaks N
  // orphan schemas + N open connection pools per CI run.
  let counter = 0;
  const created: PostgresStorage[] = [];
  runProviderConformanceTests({
    describe,
    it,
    expect,
    makeProvider: () => {
      counter++;
      const schema = `conformance_${Date.now()}_${counter}_${Math.floor(Math.random() * 1e6)}`;
      const storage = new PostgresStorage({
        connectionString: POSTGRES_URL,
        schemaName: schema,
      });
      created.push(storage);
      return new LocalMemoryProvider({ storage });
    },
  });

  afterAll(async () => {
    await Promise.allSettled(
      created.map(async (storage) => {
        try {
          await storage.__dangerousDropTable();
        } catch {
          // best-effort teardown — matches hand-rolled test pattern
        }
        await storage.close();
      }),
    );
  });
}
