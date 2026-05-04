# `ACPSessionController.start()` double-start design plan

Tracked as follow-up to commit `d989bf1` (which landed the JSDoc
documenting the current implicit-restart hazard).

## Current behavior

`packages/acp-host/src/session-controller.ts:346` — `async start(config)`:

```ts
async start(config: StartConfig): Promise<void> {
  if (this.controller) {
    this.destroy();
  }
  // ... reset ~15 state fields, spawn fresh ACPClientController ...
}
```

If `start()` is called while `this.controller` is non-null, the method
silently calls `destroy()` first and reinitializes. This nukes:

- `promptQueue`
- `completedTurns`
- `lastError`
- `currentTurn`
- `pendingWriteGate`
- `pendingElicitation`
- `plan`
- `sessionTitle`
- `sessionUpdatedAt`
- `localLabel`
- `modes`
- `modesAdvertisedByAgent`
- `permissionGatingActive`
- `models`
- `modeFallbackReason`
- `lastStartConfig` (via `destroy()`)
- `opencodeRecoveryAttempted` latch (via `destroy()`)

…all before the spawn/initialize cycle.

## Why this is load-bearing

The only in-tree caller that exploits the implicit restart is the
opencode auto-recovery path itself:

```
session-controller.ts:534-535
  this.destroy();
  await this.start(recoveredConfig);
```

That is already an **explicit** `destroy()` + `start()` pair, not a
reliance on implicit restart. Grepping the worktree, no other caller
re-invokes `start()` on a live controller.

## Caller census

### `apps/internal-gateway/`

- `host-session.ts:517` — `await controller.start(startConfig)`:
  invoked only inside `createStartedRuntimeController`, which **always
  constructs a fresh `new ACPSessionController()`** immediately before
  the `start()` call. No reuse.
- `tests/ws-bridge.test.ts:158` — fresh controller per test.
- `test-server.ts:138` — fresh controller per test.
- `host-executor.ts` also dispatches a fresh `ACPSessionController` in
  `dispatchToOneAgent` (line ~704), constructed immediately before
  start. No reuse.

Runtime switching in the gateway uses `swapActiveController` on the
`StableHostSessionController` façade — the old controller is destroyed
and replaced, not re-started.

### `apps/web-ui/`

web-ui never spawns an `ACPSessionController` directly; it talks to the
gateway over WebSocket. No callers.

### `obsidian-acp-plugin/`

- `src/session-lifecycle.ts:529` — single `await this.sessionController.start({ ... })`
  call at session bring-up time. The plugin's teardown path calls
  `destroy()` explicitly before a re-creation, so the double-start
  branch is never reached.
- Integration tests (`test/integration/*.ts`) each construct a fresh
  controller inside a per-test setup hook.

### `packages/acp-host/tests/`

Every `controller.start(...)` call in the controller's own test suite
is paired with a fresh `new ACPSessionController()` in a `beforeEach`
or similar setup. Only
`session-controller-recovery.test.ts` exercises the opencode path,
which is the explicit-restart pattern already above.

## Census conclusion

**No real caller depends on implicit restart.** The implicit branch
exists only as a defensive no-op for the one in-tree path (opencode
auto-recovery) that is already explicit. Every other caller either
constructs fresh or destroys explicitly before re-starting.

This is the evidence base for the "breaking change" proposal that
follows: the blast radius is zero in-tree, and a single
`controller.destroy()` is a trivial migration for any external caller
that might be relying on it.

## Options

### Option A — throw on double-start (breaking change)

```ts
async start(config: StartConfig): Promise<void> {
  if (this.controller) {
    throw new Error(
      "[ACPSessionController] start() called on a running controller. " +
        "Call destroy() first or construct a fresh controller."
    );
  }
  // ... unchanged ...
}
```

**Migration cost:**

- `session-controller.ts:534-535` already has the explicit
  `destroy()` + `start()` pair. No change.
- Plugin, gateway, web-ui: no callers to update (per census).
- Downstream external callers: add one `destroy()` line above any
  second `start()`. The error message tells them exactly what to do.

**Pros:**

- Surprise-free semantics. Forcing the caller to write `destroy()`
  explicitly removes the "15-field silent reset" footgun at the type /
  runtime level.
- The one path that legitimately wants restart (opencode recovery)
  already models the two steps explicitly. No API gymnastics.

**Cons:**

- Breaking for external consumers we don't know about. Not blocking —
  we can ship behind a `0.3.0-beta` major.
- Requires a deprecation cycle if we want a gentle landing.

### Option B — idempotent no-op on same config

Compare the new `config` against `this.lastStartConfig`. If equal by
deep-equals, return early. If different, either restart or throw.

**Problems:**

- `StartConfig` carries callbacks (file adapters, permission engine,
  etc.) that don't have a meaningful equality operator. Any
  reference-equality check is brittle; a deep-equals over function
  references is meaningless.
- Even with a hand-written "structural subset" equality helper, the
  semantics are muddy: does "same agent name + same workspace root"
  count? What about same `defaultModel` but different
  `surfaceAdapter`?
- The implicit restart's whole purpose in the current code is that
  you specifically wanted to trash state. Short-circuiting on
  same-config isn't the semantic most callers expect.

Option B is **not recommended**.

### Option C — deprecation + warn log, throw in next major

Keep the current behavior but emit a `this.log.warn("[...] implicit
restart detected — call destroy() explicitly. This will throw in
0.3.0")` on entry. One minor-version grace period, then flip to
Option A.

**Pros:**

- Zero runtime breakage this release.
- Operators get observability into whether any unknown caller relies
  on the implicit branch.

**Cons:**

- A warn log is trivially silenceable and easily ignored. Callers that
  never read logs never migrate.
- Still has to land Option A eventually.

## Recommendation

**Ship Option A in the next breaking release** (`0.3.0-beta`):

1. Flip the `if (this.controller)` branch from `this.destroy()` to
   `throw new Error(...)`.
2. Update the JSDoc to match the new contract.
3. Update `session-controller.ts:534-535` (opencode recovery) — already
   explicit, no change needed.
4. Add a `CHANGELOG` entry and migration note documenting the one-line
   `destroy()` call that external callers may need.
5. Add a unit test that asserts `start()` on a live controller throws
   with the specific error message.

Skip Option B entirely — the semantic muddiness is not worth the
implementation cost.

Skip Option C — the census proves no in-tree caller needs the grace
period, and external callers can be served by a clear breaking-change
note.

## Out of scope for this plan

- Whether to expose a `restart(newConfig)` convenience method. That
  is orthogonal — if it lands, it is sugar over `destroy() + start()`
  and does not change the core contract.
- Whether `opencode auto-recovery` should move into a distinct
  `_opencodeRestart()` private helper. Cosmetic, not a contract change.

## Signal to land

When scheduling the next breaking release, pick this up alongside the
other `0.3.0-beta` items. Not urgent on its own.
