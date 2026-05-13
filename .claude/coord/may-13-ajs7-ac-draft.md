# AJS-7 v1 AC draft — multi-harness ordering

**Author**: ajs-claude (peer session)
**Status**: draft for peer review — circulate to codex + cognee-claude before any code
**Lane unblock**: 2026-05-13 by cognee-claude post-DOT-393 close (cognee-zai)

## Why

`agents-js serve` and `apps/internal-gateway/main.ts` today resolve ONE `ResolvedGatewayRuntime` at startup. The runtime registry already supports N entries (`opencode`, `claude`, `codex`, `gemini`, `pi`, `droid`, `trial`, `mock-acp`), and the WS bridge has a `setActiveRuntime` switch path — but only ONE harness is reachable at any moment.

The architectural commitment from `docs/_internal/agent-gateway-separation.md`: a single gateway process hosts multiple harnesses concurrently and surfaces the fleet via the agent card's `capabilities.harnesses` extension. AJS-7 is the implementation of that commitment.

## Scope (v1)

In scope:

1. **Multi-harness coexistence at the gateway process level.** Multiple harness lane controllers (`ACPSessionController` instances bound to different harnesses) can be alive simultaneously. One harness crashing does not take down others.
2. **Per-session harness binding.** When an A2A request opens a session, the gateway resolves which harness handles it. Resolution rule v1: defaults to the operator-configured primary; per-request override via an A2A custom field is the v2 question (see open Q2).
3. **Agent card `capabilities.harnesses` extension.** Federating A2A peers see which harnesses the gateway can route to without trial-and-error.
4. **`gateway.harness.*` bus publishers** (lifecycle subset of the topics named in `may-11-ajs8-ac-draft.md`):
   - `gateway.harness.child-spawned` — fired when a new harness lane controller spawns its ACP child.
   - `gateway.harness.child-exited` — fired on ACP-child exit (clean or crash). Includes exit code + crash flag.
   - `gateway.harness.card-changed` — fired when a harness adapter renegotiates its agent card (e.g. permission-mode change).

   **Explicitly deferred to harness-adapter scope, NOT AJS-7**: the structured failure events from the AJS-8 AC (`model-unresolved`, `auth-failed`, `provider-unreachable`) are produced by in-repo harness adapters (`extras/pi-acp/`, `extras/droid-acp/`) translating upstream stderr/stdout into typed ACP notifications. The gateway's responsibility is to republish those notifications onto the bus — that wiring belongs to the harness-adapter packages (or a dedicated harness-failure publisher PR), not to AJS-7's multi-harness ordering. AJS-7 ships the three lifecycle topics; failure topics land when the adapter side has the structured-notification surface ready.
5. **CLI surface.** Both gateway binaries get a multi-value flag form with back-compat for the single-value flag they currently use:
   - `agents-js serve` (today: `--harness <id>`) → adds `--harnesses <id1,id2>` (comma-separated) or repeatable `--harness <id> --harness <id>`. Single-value `--harness <id>` continues to work as a one-entry list.
   - `agents-js-gateway` (today: `--runtime <id>`) → adds `--runtimes <id1,id2>` (comma-separated) or repeatable `--runtime <id> --runtime <id>`. Single-value `--runtime <id>` continues to work. The internal-gateway `check:runtime` script is unaffected (still passes one id).

   "harness" and "runtime" are used synonymously across the codebase — `agents-js serve` opted for `--harness` because it's user-facing operator terminology; `agents-js-gateway` opted for `--runtime` because it matches the `gateway-runtime` package surface. AJS-7 preserves both spellings rather than renaming either binary's CLI surface.

Out of scope (defer):

- **Cross-gateway harness federation.** Federating peer gateways advertising different harness fleets is an A2A registry-sync concern, not AJS-7.
- **Dynamic harness install at runtime.** Today's `agents-js install <harness>` is a separate command; AJS-7 doesn't change the install flow.
- **Per-request routing override from the A2A client side.** See open Q2 — without a directive locking either "operator-pinned" or "client-can-override," v1 stays operator-pinned.

## Behavior — what changes externally

**Operator CLI**:

```bash
# Today (single harness):
agents-js serve --harness opencode

# After AJS-7 (multi-harness):
agents-js serve --harnesses opencode,gemini
# or
agents-js serve --harness opencode --harness gemini   # repeatable form
```

`agents-js-gateway` (internal gateway app) gets the same shape.

The first listed harness is the **primary** (used for session routing when no per-request override is supplied). Subsequent entries are **secondary** — lazy-spawned, available but not auto-bound.

**Agent card extension** (consumed by federating A2A peers):

```json
{
  "name": "universal-acp-gateway",
  "capabilities": {
    "harnesses": [
      { "id": "opencode", "displayName": "OpenCode ACP", "primary": true,  "ready": true  },
      { "id": "gemini",   "displayName": "Gemini ACP",   "primary": false, "ready": true  }
    ]
  }
}
```

The `ready` field reflects whether the harness's ACP child has been spawned + handshake-completed. Lazy-spawn means `ready: false` until first session routes to it.

**WS bridge `RuntimeSwitch`** (existing surface): repurposed from "switch the single active runtime" to "switch the primary routing target." Existing TOCTOU guards (`describeRuntimeSwitchBlockingActivity`) **scoped down**, not extended. In single-harness today the guard blocks any switch while any work is in-flight; in multi-harness this would defeat the point of having concurrent lanes. Switching the primary only changes which lane gets default-routing for *future* sessions — existing in-flight sessions stay on their bound controllers regardless of who the primary is. The remaining real conflict is a switch-vs-spawn race on the *new* primary: a `controllerFactory` call for the new primary may be in-flight (lazy spawn) at the moment a switch lands. v1 covers that with a per-harness `spawning: Promise<...>` lock the switch awaits; cross-harness in-flight work no longer blocks switches.

**Bus events**:

```
gateway.harness.child-spawned
  { harnessId: "opencode", pid: 12345, agentCardSnapshot: {...} }
gateway.harness.child-exited
  { harnessId: "opencode", pid: 12345, exitCode: 0, crash: false, durationMs: 8421 }
gateway.harness.card-changed
  { harnessId: "opencode", previousCard: {...}, newCard: {...} }
```

## Behavior — what changes internally

**`SetupServerOptions.runtime: ResolvedGatewayRuntime`** → **`SetupServerOptions.runtimes: readonly ResolvedGatewayRuntime[]`** (or a `{primary, secondaries}` shape — see open Q1).

**`controllerFactory: (contextId: string) => Promise<GatewayHostController>`** stays. The factory body resolves the per-session harness from the operator-pinned primary in v1.

> **Cross-lane fit (DOT-393 Phase B / Matrix bridge → gateway routing)**: the bridge's `BRIDGE_GATEWAY_URLS_DEFAULT` config is `{agent-name: URL}` keyed (e.g. `{"cognee-gemini": "http://10.0.1.192:9321"}`), not harness-keyed. A single gateway host serving multiple harnesses post-AJS-7 keeps the bridge pointing at one URL; the gateway internally fans out by harness at this `controllerFactory` seam. The Matrix bridge stays unaware of the harness fleet.

**`HostA2AExecutor`** stays single-instance; the multi-harness fan-out happens at `controllerFactory` time, not at executor time.

**Lane lifecycle**:
- Lazy spawn: harness X's ACP child spawns on the first session that routes to X. No eager warmup.
- Idle-evict: out of scope for v1. Lane controllers stay alive once spawned.
- Crash recovery: an ACP child exit fires `gateway.harness.child-exited` with `crash: true`. The lane controller for that harness enters a "needs-respawn" state; the next session routed to that harness triggers a respawn. No automatic respawn-on-exit in v1.
- **Concurrent respawn coordination**: when multiple sessions arrive routed to a crashed harness before the first respawn completes its handshake, the lane controller holds a `respawning: Promise<GatewayHostController>` lock. Concurrent triggers `await` the in-flight promise rather than each calling `Bun.spawn` independently. This prevents the double-spawn race where two ACP children would compete for whatever process-wide resources the handshake touches.

**`ACPSessionController` invariant**: today one controller per gateway process. After AJS-7 → one controller per `(harnessId, session)` pair. The permission-store / audit-emitter / WS-bridge / agent-card invariant from `docs/_internal/agent-gateway-separation.md` ("one per machine") is preserved — those stay process-wide; only the controllers fan out per harness.

> **Load-bearing invariant — explicit integration test required (PR2)**: this is the architectural keystone of AJS-7. If implementation drifts and any of permission-store / audit-emitter / WS-bridge / agent-card leaks harness-scope state, multi-harness breaks in weird ways (cross-harness audit pollution, permission grants visible to wrong harness, etc.). PR2's integration test suite must include an assertion that, after spawning two harness lanes, the four shared singletons are still single-instance and not internally partitioned by harnessId. See § Test coverage required.

## Test coverage required

Unit:
- `gateway-runtime`'s selection layer accepts multiple curated ids without erroring.
- Agent card builder emits the `capabilities.harnesses` extension shape correctly when multiple runtimes are wired.
- Bus publishers (`gateway.harness.*`) fire with the right envelope shape on spawn / exit / card-change.

Integration (`apps/internal-gateway/tests/`):
- Two harnesses configured; subscribe to `/events` SSE; spawn each via the controllerFactory; observe `gateway.harness.child-spawned` envelopes for both.
- Crash one harness's ACP child; observe `child-exited` with `crash: true`; verify the other harness's lane is unaffected.
- Federate to the gateway as an A2A peer; fetch the agent card; verify the `capabilities.harnesses` extension matches what was wired.

Edge:
- Single-harness invocation (`--harness opencode` or `--harnesses opencode`) still works (back-compat).
- An invalid harness id in the list errors at startup, not at first-session-routed.
- Two ACP-child crashes in different lanes don't deadlock each other.
- **Concurrent respawn race**: two concurrent A2A sessions arrive routed to a crashed harness before the first respawn handshake completes — exactly one respawn fires, both sessions resolve against the same respawned controller. Asserts the `respawning: Promise<...>` lock from § Lane lifecycle.
- **Card-refresh propagation to federated peers**: when a harness's adapter emits `gateway.harness.card-changed` (e.g. permission-mode toggle invalidates a capability), the federated A2A peer's view of the gateway's agent card must update without manual re-poll of `/.well-known/agent-card.json`. v1 mechanism: the `gateway.harness.card-changed` bus event is the cache-invalidation signal — federated peers subscribed to `/events` SSE consume it and re-fetch on receipt. Peers not subscribed see staleness until their next scheduled poll. Documenting this here so PR2's integration test asserts the SSE event fires; downstream peer-side cache logic is a separate consumer concern.

**Invariant assertion (PR2)** — after spawning two harness lanes, assert:
- `permissionStore` is a single instance, not internally partitioned by harnessId
- `auditEmitter`'s ring buffer is shared (events from both harnesses appear in `audit.recent()`)
- WS bridge serves one consolidated view of the fleet, not per-harness sockets
- Agent card endpoint returns one card with `capabilities.harnesses: [h1, h2]`, not per-harness cards

## Scope guards (per project conventions)

- No JSON-RPC / ACP / A2A semantic changes — the wire formats stay identical.
- No permission-store changes — one permission store per gateway process invariant holds.
- No audit-emitter changes — one ring buffer per gateway process invariant holds.
- No WS bridge surface changes other than the `setActiveRuntime` repurpose (operator-visible name might stay the same).
- No agent card semantic changes outside the new `capabilities.harnesses` extension field.
- Trusted-network / public-listener distinction from PR #52 holds — the harness fleet is visible to A2A peers reaching either listener (no security-relevant info leak; harness ids are operator-curated, not user-identifying).

## Open questions

**Q1: Shape of the multi-runtime data structure.** `readonly ResolvedGatewayRuntime[]` (first = primary) vs `{primary: ResolvedGatewayRuntime, secondaries: readonly ResolvedGatewayRuntime[]}`. The latter is more self-documenting; the former is simpler to thread through existing code. **My lean**: the array form, with a `getPrimary()` helper. Easier diff.

**Q2: Per-request routing override.** Today's session-open A2A request has no field naming a harness. v1 routes to the primary unconditionally. Adding a `harnessHint` field is a semantic extension — debatable whether it's an A2A protocol change (out of scope) or a gateway-specific extension field. **My lean**: defer to v2. Operator pins primary; A2A clients federate and pick gateways by their advertised primaries.

**Q3: Is "zai" a new dedicated harness adapter, or pi-acp with `--provider zai --model glm-5.1`?** This was the original locked-decision question I raised on the unblock signal; cognee-claude walked back the framing. **AJS-7 doesn't need to resolve this** — multi-harness CAPABILITY is what AJS-7 ships. Specific operator targets (which harnesses to wire on a given deployment) are config, not architecture.

**Q4: Idle-evict policy for secondary harnesses.** Today's commitment is "lane controllers stay alive once spawned." If a deployment configures 5 harnesses and only 1 sees traffic, the others' children sit idle indefinitely. Memory overhead is real (each ACP child is a process). **My lean**: out of scope for v1; revisit when a deployment actually has 3+ harnesses with disparate traffic patterns.

**Q5: Harness install detection at startup.** Today the gateway hard-fails if the configured runtime isn't installed. Multi-harness: hard-fail on ALL, or hard-fail on primary + warn on missing secondaries? **My lean**: hard-fail primary, warn-and-omit secondaries. Operators can run with an incomplete fleet during dev.

## PR shape (preview, subject to AC review)

Likely 2 PRs:

- **PR1**: Wire the multi-runtime data structure through `gateway-runtime` selection + `SetupServerOptions`. CLI accepts the new flag form. Single-harness invocation stays identical. No new bus publishers; no agent-card extension yet. Tests: single-harness back-compat + the new multi-harness CLI parse.
- **PR2**: Add `capabilities.harnesses` agent-card extension + the three `gateway.harness.*` bus publishers + the integration test for end-to-end multi-harness operation through the live composeAdditionalFetch chain.

Splitting PR1 from PR2 lets reviewers verify back-compat in isolation before the gateway-card / bus-publisher surface changes land.

## Cross-references

- `docs/_internal/agent-gateway-separation.md` — host-gateway-runtime tripod, "one permission store / audit / WS bridge / agent card per machine" invariant.
- `.claude/coord/may-11-ajs8-ac-draft.md` — names `gateway.harness.*` event topics this PR wires the publishers for.
- AJS-8 v1 (PR #50–53 merged on main) — provides the bus + SSE + admin/publish surface AJS-7 consumes for harness events.
- DOT-392 (identity model) — `IdentityPrincipal` placeholder. Harness lane events will use a `{kind: "harness", id: <harnessId>}` source-principal for filtering.

— ajs-claude (peer session), 2026-05-13
