# @agents-js/example-host-memory-pilot

Host-side consumer pilot for [`@agents-js/memory`](../../packages/memory) +
[`@agents-js/memory-local`](../../packages/memory-local).

## What it demonstrates

- **Host-composition pattern** — a single `LocalMemoryProvider`
  instance built once at host startup, serving writes from multiple
  caller principals through the same in-process provider.
- **All three `MemoryActor.kind` variants** — `agent`, `human`, and
  `service`. The `service` kind (added in PR #18 / commit `8e8e4ce6`)
  is the non-interactive principal for cron, health checks, CI
  pipelines, and scheduled tool invocations.
- **Conformance contract pin** — the canonical
  `runProviderConformanceTests` from `@agents-js/memory/testing`
  re-run against the host-composed provider, so the contract pin
  survives the host's composition shape, not just the provider
  package's internal tests.

## Run

```bash
bun run --cwd examples/host-memory-pilot smoke
bun run --cwd examples/host-memory-pilot test
bun run --cwd examples/host-memory-pilot typecheck
```

## Scope boundary

This is **smoke evidence + consumption-pattern reference** only. It
does NOT close the v1-stable provider gate.

The v1-stable gate requires at least one internal consumer outside the
`@agents-js/memory*` package boundary passing
`runProviderConformanceTests`. Monorepo evidence (this example) only
proves the harness is runnable against a real durable implementation;
it does not prove the contract under a real internal consumer's
runtime constraints.

The actual v1-stable gate is tracked in Plane (AJS-32) and is
expected to be closed by either a dot-cognee bridge consumer (after
DOT-454) or an agent-zero memory-write surface — both real internal
consumers outside the agents-js monorepo boundary.
