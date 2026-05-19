import { describe, expect, it } from "bun:test";
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
  // backed by a fresh ephemeral schema per `makeProvider` call.
  let counter = 0;
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
      return new LocalMemoryProvider({ storage });
    },
  });
}
