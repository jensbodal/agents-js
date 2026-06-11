# @agents-js/example-ws-bridge-smoke

Smoke example for the gateway **WebSocket bridge** — the live-state channel
between a running gateway controller and a browser, served by
[`@agents-js/host`](../../packages/host)'s `createWSBridge` and consumed by
[`@agents-js/ui-components`](../../packages/ui-components)'s `HostWSClient`.

Demonstrates the round-trip the production web UI depends on:

- A real `HostWSClient` connects to `createWSBridge` over a live WebSocket and
  receives an **initial state snapshot** (the bridge answers the client's
  on-open `request_state` with a `state_snapshot` frame, mapped into the
  client's flat `HostState`).
- The controller emits a **gate event** mid-turn — an elicitation request
  raised by the mock ACP agent. The bridge forwards it as an `event` frame;
  the client surfaces it in `HostState.pendingElicitation`.
- The client **resolves** the gate. The resolution travels back over the
  socket, reaches the controller, and unblocks the in-flight turn — proving
  the full browser → bridge → controller → agent loop closes.
- A `set_runtime` message **flips the runtime card** end-to-end; the client
  observes the new runtime in its mapped `HostState`.

The controller is backed by `tests/mock-acp-agent.cjs` spawned as a real
`node` subprocess (the same fixture `createGatewayTestServer` uses) — the ACP
transport is genuine, nothing here stubs it.

## Notes on the gate event

The GOAL names a "permission (or write-gate)" round-trip. The `.cjs` fixture
exposes a deterministic **elicitation** probe (`"browser smoke elicitation
accept"`) but no raw `session/request_permission`, so this smoke round-trips
the elicitation request/resolve pair. Its shape on the bridge is identical to
a permission gate: the controller emits a gate event, the bridge forwards it,
the client resolves it, and the resolution reaches the controller. (The
permission-specific path is covered separately by
`packages/host/tests/ws-bridge.test.ts`, which uses an in-process mock agent
that can raise a literal `permissionRequest`.)

The smoke asserts the bridge round-trip (gate forwarded, resolved, the turn
unblocked once the resolution reaches the agent) rather than the agent's reply
*text*: the `.cjs` fixture reads the elicitation response at the nested
`result.action.action` path while the current ACP SDK sends the flat
`{ action, content }` shape, so the fixture's accept-branch copy is
wire-shape-skewed. The turn completing is itself the proof the resolution
round-tripped — the mock only sends its prompt reply from inside its
elicitation-response handler.

## Controller source

The controller comes from `createGatewayTestServer`, which exposes its
factory-owned `controller` on the returned handle. The bridge attaches to that
controller directly; the factory's A2A server stays idle (no A2A requests are
made here). The factory is invoked with `permissionMode: "default"` (not the
`bypassPermissions` test default) so the elicitation gate actually fires and
round-trips through the bridge rather than auto-resolving. The bridge wiring
mirrors `packages/host/tests/ws-bridge.test.ts`'s `createLiveBridgeHarness`
(the established WS-bridge test pattern) while swapping in the real browser
`HostWSClient` for the raw socket used there.

## Test

```bash
bun run --cwd examples/ws-bridge-smoke test
```

## Layout

```
examples/ws-bridge-smoke/
  package.json          # workspace example, private
  tsconfig.json         # extends ../../tsconfig.workspace.json
  tests/smoke.test.ts   # snapshot + gate round-trip + set_runtime assertions
  README.md             # this file
```
