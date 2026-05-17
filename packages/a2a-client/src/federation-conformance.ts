import type { HarnessCapabilityEntry } from "@agents-js/a2a";

/**
 * Contract any federation transport must satisfy to participate in
 * parent→child gateway dispatch under the v1 federation contract
 * (see `docs/federation/v1-contract.md`).
 *
 * Mirrors the `runProviderConformanceTests` pattern from
 * `@agents-js/memory/testing` so a v2 transport implementation
 * (RemoteHarnessClient over HTTP A2A, future gRPC, future WebSocket
 * bus) plugs into one harness rather than reinventing a fresh test
 * suite per transport.
 *
 * v1 ships the contract surface only; transport implementations
 * land in v2 alongside the harness body fill-in.
 */
export interface FederationTransport {
  /** Discover the child gateway's agent card via the federation path. */
  fetchChildCard(opts: { gatewayUrl: string }): Promise<unknown>;

  /** Send an A2A message/stream to the child harness. */
  sendMessageToChild(opts: {
    entry: HarnessCapabilityEntry; // must have source: "remote"
    request: unknown;
  }): AsyncIterable<unknown>;

  /** Subscribe to /events SSE from the child and re-broadcast namespaced topics. */
  subscribeChildBus(opts: {
    entry: HarnessCapabilityEntry; // must have source: "remote"
    onEvent: (event: { topic: string; payload: unknown }) => void;
  }): { close(): void };
}

/**
 * Minimal structural shape of a bun:test / vitest / jest test runner.
 * Injected so the conformance package stays framework-agnostic — matches
 * the dependency-injection style used by `@agents-js/memory/testing`.
 */
interface TestRunner {
  describe: (label: string, body: () => void) => void;
  /**
   * `test.todo(label)` form — the v1 skeleton emits only pending placeholders.
   * A v2 transport implementation will swap to value-bearing tests with
   * actual assertions; the shape here matches bun:test's `test.todo`.
   */
  testTodo: (label: string) => void;
}

/**
 * Options to construct the conformance harness against a candidate
 * federation transport implementation. Mirrors the
 * `runProviderConformanceTests` signature shape from
 * `@agents-js/memory/testing`.
 */
export interface FederationConformanceOptions {
  /** Test-runner hooks; pass `{ describe, testTodo: test.todo }` from bun:test. */
  runner: TestRunner;
  /** Factory that produces a fresh transport instance per test (used by v2 fill-in). */
  makeTransport: () => FederationTransport;
  /** Optional test name prefix (used to disambiguate when invoked from multiple suites). */
  describePrefix?: string;
}

/**
 * Federation transport conformance suite. v1 surface only —
 * test bodies are `test.todo` and become real assertions in v2
 * when an actual transport implementation lands (likely the HTTP
 * A2A RemoteHarnessClient defined in the federation contract doc).
 *
 * Usage (v2):
 * ```ts
 * import { describe, test } from "bun:test";
 * import { runFederationTransportConformanceTests } from "@agents-js/a2a-client";
 *
 * runFederationTransportConformanceTests({
 *   runner: { describe, testTodo: test.todo },
 *   makeTransport: () => new RemoteHarnessClient({ ... }),
 * });
 * ```
 */
export function runFederationTransportConformanceTests(
  options: FederationConformanceOptions,
): void {
  const { runner, describePrefix } = options;
  // `makeTransport` is destructured but unused in v1 — the v2 fill-in
  // will invoke it inside each test body. Referencing it here keeps
  // the contract honest for callers passing the factory today.
  void options.makeTransport;
  const prefix = describePrefix ? `${describePrefix} ` : "";

  runner.describe(`${prefix}federation transport — conformance (v1 skeleton)`, () => {
    // Invariant: a healthy child gateway publishes its agent card at the
    // federation path, and `fetchChildCard` returns the parsed card.
    runner.testTodo("fetchChildCard returns a valid agent card from the child gateway");

    // Invariant: unreachable / DNS-failed / TLS-failed gateway URLs surface
    // as a typed transport error rather than a raw fetch rejection.
    runner.testTodo("fetchChildCard against an unreachable gatewayUrl rejects with a typed error");

    // Invariant: response framing is chunked over the A2A wire — callers
    // iterate the async iterable and receive incremental updates rather
    // than a single buffered terminal response.
    runner.testTodo("sendMessageToChild streams responses chunked over the A2A wire");

    // Invariant: the transport is for `source: \"remote\"` entries only.
    // Local-source entries must raise rather than silently no-op so the
    // dispatcher catches misrouted calls at the boundary.
    runner.testTodo("sendMessageToChild against an entry with source !== 'remote' throws");

    // Invariant: child bus events surface under a namespaced topic of the
    // form `gateway.federation.<childAgentId>.<originalTopic>` so parent
    // subscribers can disambiguate origin without inspecting payload.
    runner.testTodo(
      "subscribeChildBus re-broadcasts events under namespaced topic `gateway.federation.<childAgentId>.<originalTopic>`",
    );

    // Invariant: `close()` is synchronous from the caller's perspective
    // and tears down the underlying SSE connection — no leaked sockets,
    // no further `onEvent` invocations after close returns.
    runner.testTodo("subscribeChildBus close() stops the SSE stream and releases the connection");

    // Invariant: transient SSE disconnects auto-reconnect with exponential
    // backoff (not a tight reconnect loop) so a flapping child does not
    // saturate the parent's outbound connection pool.
    runner.testTodo("reconnect after SSE disconnect uses exponential backoff");
  });
}
