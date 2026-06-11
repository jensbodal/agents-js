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

## Boundary

`createGatewayTestServer` only exposes an `additionalFetch` hook for the AG-UI
endpoint, not for the registry-sync handler. Rather than edit shared host test
infra, each gateway's `createSyncEndpointHandler` is served on a small sidecar
`Bun.serve`. The sync protocol is agnostic about which port the well-known
endpoint lives on, so this is the same wire path the production gateway mounts
via `composeAdditionalFetch` in `apps/internal-gateway/main.ts` — only the port
differs. The gateways themselves are real and load-bearing.

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
