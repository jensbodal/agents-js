# @agents-js/example-registry-sync-smoke

Smoke example for **cross-gateway registry sync** — gateway A discovering
gateway B's agent record over the A2A peer-sync protocol, driven through the
public [`@agents-js/a2a-client/node`](../../packages/a2a-client) sync surface
against two real gateways.

Auto-register (a gateway publishing its own `(name, url)` to the local
registry) is exercised elsewhere. The gap this pins is the **cross-gateway**
half: A learning B's record through the registry-sync pull-merge path.

Demonstrates:

- Two genuine gateways via `createGatewayTestServer`
  (`HostA2AExecutor` + `ACPSessionController` + `UniversalA2AServer`) on
  OS-assigned ports, each backed by the real `tests/mock-acp-agent.cjs`
  subprocess. Each gateway has its **own** isolated registry file.
- Gateway B publishing itself with `autoRegister` (`url` = B's *actual*
  running A2A server) and serving its peer-sync payload at the well-known
  endpoint via the real `createSyncEndpointHandler`.
- Gateway A enabling registry-sync through the **production wrapper**
  `startRegistrySync` (short interval), seeded with B as a known peer, then
  pulling B's sync endpoint, filtering/merging, and adopting B's record with
  `source="sync"`.
- A **bounded poll** asserting A's registry comes to contain B's record with
  the right provenance (`source="sync"`, B's `gateway_id`, B's real `url`).
- A **reachability** check: fetching B's agent card at the synced URL and
  asserting `200` + B's card name — proving A learned a live gateway it can
  reach, not just that a row copied between two files.

## Wire path

Each gateway mounts its `createSyncEndpointHandler` on its **own** A2A port via
`createGatewayTestServer`'s `additionalFetchFactory` seam, backed by its own
registry file. The handler returns `null` for non-sync requests, so they fall
through to the A2A server's own routing (`/.well-known/agent-card.json` still
answers). This is exactly how `apps/internal-gateway/main.ts` mounts the sync
endpoint via `composeAdditionalFetch` — the well-known sync endpoint and the
A2A server share one port. The gateways themselves are real and load-bearing.

## Test

```bash
bun run --cwd examples/registry-sync-smoke test
```

## Typecheck

```bash
bun run --cwd examples/registry-sync-smoke typecheck
```

## Layout

```
examples/registry-sync-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json
  tests/smoke.test.ts   # two gateways -> enable sync -> A discovers B -> reachable
  README.md             # this file
```
