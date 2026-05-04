# ADR: Per-contextId Session Lanes in `HostA2AExecutor`

Status: **Accepted**. Both rollout steps (lane bookkeeping on a shared
controller; dedicated controller per lane) shipped on branch `agents-js`.
Owner: tpm-agents-js
Related design doc: `docs/architecture/host-and-agent-layers.md` §3, §4a, §5a

This ADR records the decision to replace `HostA2AExecutor`'s
single-controller / global-mutex model with per-contextId `SessionLane`s,
and the two-step rollout that delivered it. The sections below describe
the final architecture; readers wanting only the decision should stop
after §3. Later sections document the migration strategy and regression
tests that produced the current state.

## Rollout summary

- **Step 1 (lane bookkeeping on a shared controller):** `SessionLane`
  maps per `contextId` with per-lane `inFlightPrompt` mutexes,
  replacing the executor-wide mutex. Distinct contextIds no longer
  republish each other's outcomes.
- **Step 2 (per-lane controllers):** `HostA2AExecutor` accepts a
  `controllerFactory`; factory-mode lanes spawn their own
  `ACPSessionController`. Per-lane idle sweep (30-minute default) tears
  down dormant lanes. `cancelTask` routes through
  `taskToLane.get(taskId).controller.cancel()`.
- **Scope boundary:** WS-bridge + AG-UI remain attached to the primary
  controller only — surface-event broadcasts cover a single lane.
  Multi-lane surface fan-out is tracked separately.

## 1. Why this ADR exists

The backlog item title is misleading by now: the literal "first task by Map
insertion order" hack was already replaced in a prior session with an
`owningTaskId` field that tracks the task currently holding the
`inFlightPrompt` mutex (`apps/internal-gateway/host-executor.ts:108-116`,
`597-608`). That fix correctly routes controller chunks to the task that is
actually running the prompt and is covered by a regression test
(`apps/internal-gateway/tests/host-executor.test.ts:464-586`).

What is **not** fixed is the underlying architectural issue the same backlog
item points at: `HostA2AExecutor` is a **single-controller** executor, and
two genuinely independent A2A `contextId`s landing concurrently still
serialize through one global mutex against one ACP session. The
"join-and-republish" path (`host-executor.ts:233-251`) republishes the
owner's `PromptOutcome` on the joiner's `eventBus` regardless of whether the
joiner is a same-`contextId` retry (correct) or a different-`contextId`
independent request (wrong — joiner sees the owner's text).

This plan is the per-contextId session-map refactor that the architecture
doc (§5a) calls for. It is large enough that landing it in one session is
not safe — call sites in `ws-bridge.ts`, `agui-endpoint.ts`,
`agui-run-session.ts`, and `index.ts` all assume a single shared
controller. Splitting the work into the commits below keeps each step
individually testable.

## 2. Current architecture trace (file:line)

### 2a. `apps/internal-gateway/host-executor.ts`

- `class HostA2AExecutor` — `host-executor.ts:94-726`
- `private controller: GatewayHostController` — `host-executor.ts:95`
- `private activeTasks = new Map<string, ActiveTask>()` (keyed by **taskId**, not contextId) — `host-executor.ts:96`
- `private inFlightPrompt: Promise<PromptOutcome> | null` (global single-slot mutex) — `host-executor.ts:108`
- `private owningTaskId: string | null` (set in `runPrompt` start, cleared on resolve) — `host-executor.ts:116`
- `private subscribed = false` (one-shot subscribe to the single controller) — `host-executor.ts:117`
- `execute()` — `host-executor.ts:151-291`
  - Joins existing `inFlightPrompt` if set, else owns a new one — `host-executor.ts:232-251`
  - `await pending` returns the **owner's** outcome regardless of joiner identity — `host-executor.ts:246`
  - Joiner publishes owner's text on its own bus via `publishTerminalTask(task, outcome.normalizedUserMessage, …)` — `host-executor.ts:261-265`
- `runPrompt()` — `host-executor.ts:303-344`
  - Sets `owningTaskId = task.taskId` — `host-executor.ts:309`
  - Calls `controller.sendPrompt(...)` directly (single shared controller) — `host-executor.ts:317`
  - Reads `task.textBuffer` populated by `subscribeToController` callbacks — `host-executor.ts:321`
- `subscribeToController()` — `host-executor.ts:597-677`
  - Routes events to `this.activeTasks.get(this.owningTaskId)` (post-hack correct routing) — `host-executor.ts:605-608`
  - Per-event-type branches all push into `task.textBuffer` / publish on `task.eventBus` — `host-executor.ts:610-675`

### 2b. `apps/internal-gateway/host-session.ts`

- `interface HostSession { controller: GatewayHostController; … }` — `host-session.ts:69-78`
- `createHostSession(config: HostSessionConfig): Promise<HostSession>` — `host-session.ts:559-625`
  - Creates **one** `ACPSessionController`, wraps it in `StableHostSessionController` — `host-session.ts:576-586`
  - All consumers receive `session.controller` (singular) — `host-session.ts:590-624`
- `class StableHostSessionController` — `host-session.ts:99-188`
  - Backs a single active controller; supports runtime swap but not multi-session concurrency

### 2c. Reference implementation in `packages/a2a/src/executor.ts`

- `private sessionMap = new Map<string, string>()` (A2A contextId → ACP sessionId) — `packages/a2a/src/executor.ts:146`
- `private sessionToTask = new Map<string, string>()` (ACP sessionId → A2A taskId, used for incoming-event routing) — `packages/a2a/src/executor.ts:141`
- `getActiveTaskBySessionId(sessionId)` (clean reverse lookup, no insertion-order assumption) — `packages/a2a/src/executor.ts:469-472`
- `ensureSession(task)` (allocates a fresh ACP session per first-seen contextId, persists the map across restarts) — `packages/a2a/src/executor.ts:370-396`
- `runTask` is fully per-task; no global mutex, no joiner-republish path

This is the shape `HostA2AExecutor` needs to converge on. The mismatch is
that `ACPtoA2AExecutor` talks to a low-level `ClientSideConnection` that
multiplexes sessions natively, whereas `HostA2AExecutor` talks to an
`ACPSessionController` that owns one session at a time. See §3 for how to
bridge that gap.

### 2d. Consumers that assume single controller

- `apps/internal-gateway/index.ts` — boots `createHostSession(...)`, hands `session.controller` to `HostA2AExecutor`
- `apps/internal-gateway/ws-bridge.ts` — subscribes to `session.controller` for surface-event broadcasting
- `apps/internal-gateway/agui-endpoint.ts` and `agui-run-session.ts` — drive the same controller directly for AG-UI streaming
- `apps/internal-gateway/surface-broadcaster.ts` — registers as a single sink against the single controller

Any per-contextId refactor must either (a) keep the WS/AG-UI consumers on a
"primary" controller while routing A2A through a session pool, or (b)
extend WS/AG-UI to also be per-contextId. Option (a) is cheaper and
matches how the WS bridge currently scopes broadcasts (single host
session); option (b) is the long-term direction once the layer-model
extraction in `host-and-agent-layers.md` §5b lands.

## 3. Proposed shape

### 3a. New `SessionLane` value type (host-executor.ts internal)

```ts
interface SessionLane {
  contextId: string;
  /**
   * Per-lane single-slot mutex. Same-contextId requests serialize against
   * this; different-contextId requests use disjoint lanes and run in
   * parallel. Replaces the executor-wide `inFlightPrompt`.
   */
  inFlightPrompt: Promise<PromptOutcome> | null;
  /**
   * The task currently holding the lane's mutex. Routes incoming
   * controller events from this lane's session to the right event bus.
   */
  owningTaskId: string | null;
  /**
   * The lane-local controller. Phase 1 (3c.i) keeps this pointed at the
   * shared singleton and uses ACP `newSession` per lane via
   * `controller.newSession()` *only on first contact for the lane*.
   * Phase 2 (3c.ii) gives each lane its own dedicated controller.
   */
  controller: GatewayHostController;
  /** ACP sessionId allocated for this contextId. */
  acpSessionId: string | null;
  /** Subscription handle so we can unsubscribe on lane teardown. */
  unsubscribeController: (() => void) | null;
}
```

### 3b. `HostA2AExecutor` field layout

```ts
class HostA2AExecutor {
  // The "primary" controller — kept for WS bridge / AG-UI compatibility
  // (they expect a single subscribable surface). New A2A traffic does not
  // route through this directly anymore.
  private primaryController: GatewayHostController;

  // Replaces both `inFlightPrompt` and `owningTaskId`:
  private lanes = new Map<string /* contextId */, SessionLane>();

  // Replaces the bare taskId map; tasks now live inside their lane:
  // (kept on the executor for fast `cancelTask(taskId)` lookup)
  private taskToLane = new Map<string /* taskId */, SessionLane>();

  // ...
}
```

### 3c. Two-phase migration of session ownership

The single-controller / multi-session story needs care because
`ACPSessionController` does not currently expose a way to drive multiple
sessions concurrently from one controller — its `state.sessionId` is
singular. There are two viable migration paths.

#### 3c.i. Phase 1 — lane bookkeeping only, still one controller

- Allocate one `SessionLane` per contextId.
- All lanes share the singleton `primaryController`.
- The lane's `inFlightPrompt` is the per-contextId mutex (replaces the
  global one).
- `runPrompt` for a lane still calls `primaryController.sendPrompt(...)`,
  but only after acquiring **a global controller-busy gate** (because the
  controller can only handle one prompt at a time).
- The visible behavior change: same-contextId retries dedup against the
  lane mutex; different-contextId requests still serialize at the
  controller gate, but they no longer republish each other's outcomes —
  each lane has its own `PromptOutcome`.

This phase fixes the joiner-republish bug **without** changing process
topology. It is the minimal correct-semantics fix.

#### 3c.ii. Phase 2 — dedicated controller per lane

- Spawn a fresh `ACPSessionController` (and underlying ACP process) per
  contextId on first contact.
- Per-lane mutex is now sufficient — there is no shared resource between
  lanes.
- WS bridge / AG-UI continue to attach to a designated "primary" lane (or
  evolve to per-lane subscribers); see §6 risks.

Phase 2 unlocks true parallel execution of independent contextIds. It is
also where `HostA2AExecutor` finally matches the architecture-doc picture
(host → gateway with a session pool keyed by contextId → ACP).

Recommended commit cadence: ship Phase 1 first, validate, then ship Phase
2 in a follow-up. The plan below splits commits accordingly.

## 4. Migration strategy (commit sequence)

Each commit is intended to be individually green and revertable.

### Commit 1: introduce `SessionLane` type and lane bookkeeping (no behavior change)

- Add `SessionLane` interface and `lanes` / `taskToLane` maps to
  `HostA2AExecutor`.
- On `execute()`, look up or create the lane for `context.contextId` but
  keep the old `inFlightPrompt` / `owningTaskId` global state in parallel.
- Assert at lane lookup: a same-contextId concurrent request resolves to
  the same lane object (pin via test).
- Pre-existing tests must continue to pass unchanged.

### Commit 2: move mutex into the lane, delete `inFlightPrompt` field

- Replace `this.inFlightPrompt` reads/writes with
  `lane.inFlightPrompt`.
- Add a separate `private controllerBusy: Promise<void> | null` global
  gate that lane-runs serialize against (Phase 1 still has one
  controller).
- `subscribeToController` now routes via
  `this.lanes.get(currentControllerLaneContextId)`. Track which lane
  currently owns the controller via a `currentControllerLaneContextId`
  field updated under the gate.
- Update the regression test
  (`tests/gateway-executor-concurrent-e2e.test.ts`) that asserts
  same-contextId dedup; semantics are unchanged.
- New test: two **different** contextIds dispatched concurrently produce
  two distinct response texts on their respective buses (no cross-talk).
  See §5 for scaffolding.

### Commit 3 (optional, gated on validation): per-lane controller

- Extend `host-session.ts` with a `createHostController(...)` factory that
  spawns and starts a fresh `ACPSessionController` independently of
  `createHostSession`.
- `HostA2AExecutor` accepts an optional `controllerFactory` in its
  options; when supplied, allocate a new controller per lane in
  `getOrCreateLane`.
- Default factory falls back to "share the primary controller" so
  existing call sites are unaffected.
- New test: two different contextIds dispatched concurrently both make
  forward progress without serializing against each other (mock-agent
  prompt counter ≥ 2 with overlapping prompt windows).

### Commit 4: cleanup

- Delete the global `controllerBusy` gate when Phase 2 is on by default.
- Delete the joiner-republish path (`host-executor.ts:232-251`) — same-
  contextId concurrency now resolves at the lane mutex with no special
  case.
- Delete the now-redundant `subscribed = false` one-shot guard; lanes
  manage their own subscriptions.
- Update `host-and-agent-layers.md` §4a to mark the violation closed and
  link to the relevant commits.

## 5. Regression test scaffolding

Two new tests in
`apps/internal-gateway/tests/gateway-executor-concurrent-e2e.test.ts`.

### 5a. "different contextIds get distinct responses" (Phase 1 must pass)

```ts
test("concurrent different contextIds receive distinct responses", async () => {
  const ctxA = `ctx-A-${crypto.randomUUID()}`;
  const ctxB = `ctx-B-${crypto.randomUUID()}`;

  // Mock agent should echo back a tag derived from the prompt so we can
  // assert which response each contextId received. The current
  // tests/mock-acp-agent.cjs already echoes the prompt content; if not,
  // extend it to include a per-prompt tag in the agent_message_chunk.
  const [respA, respB] = await Promise.all([
    sendMessage("ALPHA-payload", ctxA),
    sendMessage("BETA-payload", ctxB),
  ]);

  expect(respA.ok).toBe(true);
  expect(respB.ok).toBe(true);

  const bodyA = await respA.json();
  const bodyB = await respB.json();

  const textA = extractFinalTaskText(bodyA);
  const textB = extractFinalTaskText(bodyB);

  // Critical: each context received its OWN response, not cross-talked.
  expect(textA).toContain("ALPHA");
  expect(textA).not.toContain("BETA");
  expect(textB).toContain("BETA");
  expect(textB).not.toContain("ALPHA");
}, 10000);
```

`extractFinalTaskText` is a small helper that pulls the terminal task's
agent message text from a JSON-RPC response — see existing
`extractCompletedTaskText` in `tests/host-executor.test.ts:609+` for
prior art (port to e2e style with `await response.json()`).

This test **fails today** under the global-mutex / joiner-republish
behavior (the second contextId's joiner publishes the owner's text). It
**passes** after Commit 2.

### 5b. "different contextIds run in parallel, not serially" (Phase 2 must pass)

```ts
test("concurrent different contextIds make overlapping prompt progress", async () => {
  // Mock agent supports a `__SLEEP_MS__:<ms>:<tag>` directive that holds
  // the prompt open for <ms> before responding with <tag>. This test
  // requires that the executor does not serialize different contextIds
  // through one underlying ACP session.
  const ctxA = `ctx-A-${crypto.randomUUID()}`;
  const ctxB = `ctx-B-${crypto.randomUUID()}`;
  const SLEEP_MS = 500;

  const start = Date.now();
  await Promise.all([
    sendMessage(`__SLEEP_MS__:${SLEEP_MS}:ALPHA`, ctxA),
    sendMessage(`__SLEEP_MS__:${SLEEP_MS}:BETA`, ctxB),
  ]);
  const elapsed = Date.now() - start;

  // Serial would be ~1000ms, parallel ~500ms. Allow generous slack but
  // the boundary is clear.
  expect(elapsed).toBeLessThan(SLEEP_MS * 1.6);
}, 10000);
```

Requires a `__SLEEP_MS__` extension to `tests/mock-acp-agent.cjs`. This
test **fails** in Phase 1 (different contextIds still serialize at the
controller gate) and **passes** after Commit 3.

### 5c. Existing tests to update

- `tests/gateway-executor-concurrent-e2e.test.ts` "concurrent message/send
  calls are serialized by the mutex" — keep the success assertion, but
  rename and update the comment to reflect the new lane-mutex semantics
  (concurrent **same-contextId** requests are dedup'd at the lane;
  concurrent **different-contextId** requests are independent). The five
  test requests have no `contextId` argument and so will all collapse
  onto one lane keyed by `undefined` — make that explicit by passing
  `undefined` and renaming the test to "concurrent default-contextId".
- `tests/gateway-executor-concurrent-e2e.test.ts` "same contextId
  concurrent calls dedup to single underlying prompt" — this contract is
  now the lane mutex's job. Keep the test, update comments.
- `tests/host-executor.test.ts` "routes controller chunks to the task
  that currently owns the prompt" — semantics survive (each lane has its
  own `owningTaskId`). May need a small update to the stub controller to
  return distinct sessionIds across `newSession` calls if Phase 2 lands.

## 6. Risks and open questions

### 6a. ACP process scaling

Phase 2 spawns one ACP process per A2A `contextId`. For long-lived hosts
that accumulate many conversations, this is unbounded growth. Need:

- An LRU policy on the lane map with explicit `destroy()` on eviction.
- Or a session-idle timeout that tears down dormant lanes after N minutes
  of no traffic.

Decision deferred until Phase 1 ships; current real-world contextId
cardinality is small (hosts use stable contextIds per conversation), so
the scaling problem is not immediate.

### 6b. WS bridge / AG-UI surface attachment

Both `ws-bridge.ts` and the AG-UI endpoint subscribe to a single
controller for surface-event broadcasting. Per-lane controllers break
this implicit "one broadcast topic per gateway" assumption. Options:

- Designate the first lane created as the "primary" lane that WS/AG-UI
  attach to. Loses cross-context surface visibility but matches today's
  actual usage (one Obsidian session = one contextId).
- Move WS/AG-UI to multiplex across lanes with a `contextId` field on
  every published surface frame. More invasive, requires client-side
  filtering.

Pick option (a) for Phase 2; track option (b) as a separate item once a
multi-conversation host actually exists.

### 6c. Persistence of the contextId → ACP sessionId map

`ACPtoA2AExecutor` persists its `sessionMap` to disk via
`SessionIdStore` so ACP sessions survive gateway restarts. The
host-executor counterpart should consider the same, but `ACPSessionController`
already has its own session-storage adapter
(`createDiskBackedSessionStorage` in `host-session.ts:286-346`). Need to
verify whether the controller's persistence is enough or whether the
lane → sessionId map needs separate snapshotting.

### 6d. Test mock extensions

5b requires `__SLEEP_MS__` support in the mock ACP agent
(`tests/mock-acp-agent.cjs`). Add carefully — the existing
`__PROMPT_COUNT__` diagnostic is read by an existing test, so the new
directive must not collide with any prompt-counting logic.

### 6e. Cancel semantics across lanes

`cancelTask(taskId)` today calls `this.controller.cancel()` which
cancels the singleton's in-flight prompt. With per-lane controllers, it
needs to look up `taskToLane.get(taskId)?.controller.cancel()`. Cross-
lane cancel (cancel-all) is a separate API that does not exist today and
should not be added speculatively.

### 6f. The architecture doc's `@agents-js/host` extraction (§5b)

This plan only touches the gateway internals. The broader extraction of a
host-layer package is independent and should not be conflated with this
work. Once Phase 2 ships, the gateway is correctly a "session-pool
protocol bridge" and the host-extraction work can proceed cleanly on its
own timeline.

## 7. Out of scope

- Mention middleware extraction (architecture-doc §4b).
- Pluggable A2A transports (§5e).
- `A2ADelegationMetadata` shared type (§5c).
- `TraceSink` interface (§5d).

These are separately tracked; addressing any of them here would conflate
unrelated concerns and inflate the diff beyond reviewability.

## 8. Estimated effort

- Phase 1 (Commits 1, 2, partial 4): ~3-4 hours focused work + tests.
- Phase 2 (Commit 3, remainder of 4): ~4-6 hours including the
  mock-agent extension and validation against the Obsidian plugin's
  ACPSessionController flow.

Both phases together comfortably exceed a single 60-90 minute / ≤150
tool-call session budget, which is why this plan exists rather than the
refactor itself.
