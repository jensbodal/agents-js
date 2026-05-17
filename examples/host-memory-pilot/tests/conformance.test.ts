import { describe, expect, it } from "bun:test";
import { runProviderConformanceTests } from "@agents-js/memory/testing";
import { LocalMemoryProvider, noopPolicyGate, SqliteStorage } from "@agents-js/memory-local";

/**
 * Pin the v1 provider contract against the host-composed
 * `LocalMemoryProvider` (in-memory sqlite + noop gate). Re-runs the
 * canonical conformance harness through the same composition shape a
 * host uses at startup — proves the contract still holds when the
 * provider is built via the public package surface, not just via the
 * provider's own internal tests.
 */
runProviderConformanceTests({
  describe,
  it,
  expect,
  makeProvider: () =>
    new LocalMemoryProvider({
      storage: new SqliteStorage({ dbPath: ":memory:" }),
      policyGate: noopPolicyGate,
    }),
});
