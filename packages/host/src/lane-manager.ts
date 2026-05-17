/**
 * `HarnessLaneManager` — owns harness-fleet bookkeeping for the
 * gateway process.
 *
 * Ownership model:
 *
 * - The manager does NOT cache lane controllers. Every call to
 *   {@link HarnessLaneManager.getOrSpawnLane} produces a fresh
 *   `ACPSessionController` via the injected factory — one controller per
 *   `(harnessId, sessionContext)` pair by design. `HostA2AExecutor` owns
 *   each returned controller and is free to destroy it on idle eviction
 *   without the manager handing out stale references on the next call.
 * - The manager DOES track which controllers are currently alive (the
 *   ones whose `onProcessExit` hasn't fired yet) so that `destroy()`
 *   on gateway shutdown can tear down the live set deterministically
 *   even when the executor still holds outstanding references.
 *
 * What the manager publishes / mutates:
 *
 * 1. **Fleet readiness** — `gatewayCard.capabilities.harnesses` is
 *    pre-populated with one `ready: false` entry per configured harness.
 *    On the first successful spawn of a harness, `ready` flips to `true`
 *    in place and `gateway.harness.card-changed` fires (cache-invalidation
 *    signal for federation peers consuming `/events`). On the last live
 *    controller's exit for a harness, `ready` flips back to `false` and
 *    `card-changed` fires again.
 *
 * 2. **Per-spawn lifecycle** — `gateway.harness.child-spawned` fires
 *    on every successful spawn (one per `getOrSpawnLane` resolution);
 *    `gateway.harness.child-exited` fires on every observed exit.
 *
 * 3. **Card-renegotiation** — subscribed-to session events
 *    (`mode_changed`, `permission_gating_status`, `config_option_changed`)
 *    trigger a structural diff check on the per-harness capability slice;
 *    `card-changed` fires only when the diff is non-empty.
 *
 * Idle-evict, automatic respawn-on-exit, and per-request routing
 * override are all out of scope for v1 — deferred to a later version.
 */
import type { GatewayAgentCard, HarnessCapabilityEntry } from "@agents-js/a2a";
import type { ACPSessionEvent, ProcessExitInfo } from "@agents-js/acp-host";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";

import type { GatewayBus } from "./gateway-bus.ts";
import {
  publishHarnessCardChanged,
  publishHarnessChildExited,
  publishHarnessChildSpawned,
} from "./gateway-bus-publishers.ts";
import type { GatewayHostController } from "./host-session.ts";

/**
 * One entry in the operator-configured harness fleet. `primary: true`
 * marks the default routing target; {@link HarnessLaneManager.getPrimaryHarnessId}
 * reads the (validated single) primary out of the entries array.
 */
export interface HarnessFleetEntry {
  id: string;
  displayName: string;
  runtime: ResolvedGatewayRuntime;
  primary: boolean;
}

/**
 * Constructor options for {@link HarnessLaneManager}. Pass the live
 * `gatewayCard` reference (the manager mutates `capabilities.harnesses`
 * in place), the in-process `bus`, and a `createController` factory the
 * composition root closes over its singleton dependencies
 * (`permissionStore`, `permissionEngine`, workspace, adapters).
 */
export interface HarnessLaneManagerOptions {
  entries: readonly HarnessFleetEntry[];
  /**
   * Live mutable agent-card reference. The lane manager pre-populates
   * `capabilities.harnesses` at construction and mutates the array's
   * entries in place on spawn / exit. Callers MUST NOT swap the
   * `harnesses` slot out — keeping the same array reference is how
   * federated peers reading the card observe ready-state transitions.
   */
  gatewayCard: GatewayAgentCard;
  bus: GatewayBus;
  /**
   * Factory the manager calls to spawn a per-session lane controller.
   * Composition root closes over `permissionStore`, `permissionEngine`,
   * `workspacePath`, and the file/surface adapter handles so this seam
   * has no dependency on those concerns. The factory's promise MUST
   * resolve only AFTER the underlying controller's `start()` has fully
   * resolved — `onProcessExit` registration is order-sensitive per
   * `ACPSessionController` semantics (handlers cleared per `start()`).
   */
  createController: (entry: HarnessFleetEntry) => Promise<GatewayHostController>;
}

/**
 * Per-controller tracking: holds the unsubscribe handles registered at
 * spawn time so `destroy()` can release the session-event subscription
 * cleanly. The `onProcessExit` subscription is deliberately NOT
 * unsubscribed at teardown time — the synchronous child-kill triggered
 * by `controller.destroy()` causes the `exit` event to fire on a later
 * tick, and the listener must still be present to observe it (so
 * `gateway.harness.child-exited` publishes correctly).
 */
interface LiveController {
  controller: GatewayHostController;
  unsubscribeSession: () => void;
}

/**
 * Per-harness slot bookkeeping. Holds the mirrored capability entry
 * (kept in lockstep with `gatewayCard.capabilities.harnesses`) and the
 * set of currently-alive controllers for accurate ready-state tracking.
 */
interface HarnessSlot {
  entry: HarnessFleetEntry;
  capability: HarnessCapabilityEntry;
  liveControllers: Map<GatewayHostController, LiveController>;
}

/**
 * Owns harness-fleet bookkeeping for the gateway process: lazy-spawns
 * per-session lane controllers via the injected factory, mutates the
 * live `gatewayCard.capabilities.harnesses` slice in place to reflect
 * ready-state transitions, and publishes `gateway.harness.*` lifecycle
 * events onto the in-process bus.
 *
 * Lanes with `source: "remote"` in their fleet entry are future
 * routing branches not yet handled by {@link HarnessLaneManager.getOrSpawnLane};
 * the federation contract is documented in `docs/federation/v1-contract.md`.
 *
 * See {@link HarnessLaneManagerOptions} for constructor inputs.
 */
export class HarnessLaneManager {
  private readonly entries: readonly HarnessFleetEntry[];
  private readonly gatewayCard: GatewayAgentCard;
  private readonly bus: GatewayBus;
  private readonly createController: (entry: HarnessFleetEntry) => Promise<GatewayHostController>;
  private readonly slots = new Map<string, HarnessSlot>();
  /**
   * Current primary-routing target. Mutable post-construction via
   * {@link setPrimaryHarnessId}; `controllerFactory` consumers read this
   * to bind new sessions to the operator-pinned primary.
   */
  private primaryHarnessId: string;
  private destroyed = false;

  constructor(opts: HarnessLaneManagerOptions) {
    if (opts.entries.length === 0) {
      throw new Error("HarnessLaneManager requires at least one entry");
    }
    const primaries = opts.entries.filter((entry) => entry.primary);
    if (primaries.length !== 1) {
      throw new Error(
        `HarnessLaneManager requires exactly one primary entry; got ${primaries.length}`,
      );
    }
    const idSet = new Set<string>();
    for (const entry of opts.entries) {
      if (idSet.has(entry.id)) {
        throw new Error(`HarnessLaneManager: duplicate harness id "${entry.id}"`);
      }
      idSet.add(entry.id);
    }

    this.entries = opts.entries;
    this.gatewayCard = opts.gatewayCard;
    this.bus = opts.bus;
    this.createController = opts.createController;
    // biome-ignore lint/style/noNonNullAssertion: validated above
    this.primaryHarnessId = primaries[0]!.id;

    // Pre-populate the agent-card slice + slot map. All entries start
    // `ready: false` by design: the fleet is visible to federated peers
    // before any session lazy-spawns.
    //
    // Slot entries are SHALLOW-CLONED off the caller's input so we can
    // mutate `slot.entry.primary` during `setPrimaryHarnessId` without
    // leaking the mutation back to the caller's input fleet array.
    const cardEntries: HarnessCapabilityEntry[] = [];
    for (const entry of opts.entries) {
      const capability: HarnessCapabilityEntry = {
        id: entry.id,
        displayName: entry.displayName,
        primary: entry.primary,
        ready: false,
      };
      cardEntries.push(capability);
      this.slots.set(entry.id, {
        entry: { ...entry },
        capability,
        liveControllers: new Map(),
      });
    }
    this.gatewayCard.capabilities.harnesses = cardEntries;
  }

  /** Primary harness id — the operator-pinned default routing target. */
  getPrimaryHarnessId(): string {
    return this.primaryHarnessId;
  }

  /**
   * Switch the primary-routing target to `newPrimaryId`. This changes
   * which harness new sessions route to via the
   * `controllerFactory(contextId)` delegate; existing in-flight lane
   * controllers stay bound to the harness they were spawned on and are
   * NOT torn down here. The operator gets a new routing default; live
   * sessions don't get yanked mid-turn.
   *
   * Side effects:
   *   1. `slot.capability.primary` flag flips for both the old primary
   *      and the new primary (mutated in place on the live agent-card).
   *   2. `gateway.harness.card-changed` publishes for each affected entry
   *      so federated peers consuming `/events` see the diff without
   *      re-fetching `/.well-known/agent-card.json`.
   *   3. `this.primaryHarnessId` updates so subsequent calls to
   *      {@link getPrimaryHarnessId} return the new id.
   *
   * No-ops cleanly when `newPrimaryId === this.primaryHarnessId`.
   * Throws on unknown `newPrimaryId` (dynamic install of a non-fleet
   * runtime stays out of v1 scope).
   */
  setPrimaryHarnessId(newPrimaryId: string): HarnessFleetEntry {
    if (this.destroyed) {
      throw new Error("HarnessLaneManager: destroyed; cannot switch primary");
    }
    const newSlot = this.slots.get(newPrimaryId);
    if (!newSlot) {
      throw new Error(`HarnessLaneManager: unknown harnessId "${newPrimaryId}"`);
    }

    if (newPrimaryId === this.primaryHarnessId) {
      // Return a fresh snapshot. `slot.entry` is internal cloned state
      // (see constructor); returning `{...slot.entry}` keeps the caller
      // from holding a reference to internal state and ensures the
      // returned `primary` value reflects current truth.
      return { ...newSlot.entry };
    }

    // biome-ignore lint/style/noNonNullAssertion: invariant — primaryHarnessId always refers to a configured slot
    const oldSlot = this.slots.get(this.primaryHarnessId)!;

    // Snapshot BOTH entries before mutating so the card-changed payload
    // carries a faithful previous/new diff per harness.
    const oldPrevious: HarnessCapabilityEntry = { ...oldSlot.capability };
    const newPrevious: HarnessCapabilityEntry = { ...newSlot.capability };

    oldSlot.capability.primary = false;
    newSlot.capability.primary = true;
    // Keep the internal slot.entry.primary in sync with capability.primary
    // so the returned snapshot reflects the new state. Internal cloning
    // at construction means this does NOT leak the mutation to the
    // caller's input fleet array.
    oldSlot.entry.primary = false;
    newSlot.entry.primary = true;
    this.primaryHarnessId = newPrimaryId;

    const oldNew: HarnessCapabilityEntry = { ...oldSlot.capability };
    const newNew: HarnessCapabilityEntry = { ...newSlot.capability };

    publishHarnessCardChanged(this.bus, {
      harnessId: oldSlot.entry.id,
      previousEntry: oldPrevious,
      newEntry: oldNew,
    });
    publishHarnessCardChanged(this.bus, {
      harnessId: newSlot.entry.id,
      previousEntry: newPrevious,
      newEntry: newNew,
    });

    return { ...newSlot.entry };
  }

  /**
   * True when `harnessId` is in the configured fleet. Used by the WS
   * bridge to validate a runtime-switch request before invoking
   * {@link setPrimaryHarnessId} — dynamic install of a non-configured
   * runtime is out of v1 scope.
   */
  hasHarness(harnessId: string): boolean {
    return this.slots.has(harnessId);
  }

  /**
   * Read-only lookup of the configured runtime for `harnessId`. The WS
   * bridge uses this to fetch the target's `acp.command` for a
   * `fetchRuntimeModels` probe BEFORE committing to the switch via
   * {@link setPrimaryHarnessId} — so an async failure pre-flip doesn't
   * leave the gateway in a half-switched state.
   *
   * Throws on unknown id (use {@link hasHarness} to pre-check).
   */
  getHarnessRuntime(harnessId: string): ResolvedGatewayRuntime {
    const slot = this.slots.get(harnessId);
    if (!slot) {
      throw new Error(`HarnessLaneManager: unknown harnessId "${harnessId}"`);
    }
    return slot.entry.runtime;
  }

  /**
   * Returns true when the manager has at least one currently-alive
   * lane controller for `harnessId` (i.e. a session bound to that
   * harness that hasn't hit its `onProcessExit` yet). The WS bridge's
   * scoped-down switch-blocker reads this for the OLD primary only —
   * cross-harness in-flight work no longer blocks a primary switch.
   */
  hasLiveLanesForHarness(harnessId: string): boolean {
    const slot = this.slots.get(harnessId);
    if (!slot) return false;
    return slot.liveControllers.size > 0;
  }

  /**
   * Snapshot of `gatewayCard.capabilities.harnesses` as a fresh array
   * of cloned entries. Used as the `capabilities` field on
   * `child-spawned` payloads so subscribers see the at-the-moment
   * fleet state without aliasing the live mutable card array.
   */
  getHarnessCapabilityEntries(): HarnessCapabilityEntry[] {
    const arr = this.gatewayCard.capabilities.harnesses ?? [];
    return arr.map((e) => ({ ...e }));
  }

  /**
   * Spawn a fresh lane controller for the given harness + session
   * context. Always produces a new controller — the manager does not
   * cache or reuse controllers across calls. The caller (typically
   * `HostA2AExecutor`) owns the returned controller's lifecycle.
   *
   * On the first successful spawn for a harness, the harness's
   * capability `ready` flag flips `false → true` and `card-changed`
   * publishes for federation cache-invalidation. Every spawn publishes
   * `child-spawned`.
   */
  async getOrSpawnLane(harnessId: string, _contextId: string): Promise<GatewayHostController> {
    if (this.destroyed) {
      throw new Error("HarnessLaneManager: destroyed; cannot spawn new lanes");
    }
    const slot = this.slots.get(harnessId);
    if (!slot) {
      throw new Error(`HarnessLaneManager: unknown harnessId "${harnessId}"`);
    }

    const controller = await this.createController(slot.entry);

    // If the manager was destroyed while createController was in flight,
    // immediately tear down the resolved controller and surface the
    // shutdown error rather than handing out a controller that will
    // never be cleaned up by destroy()'s liveControllers snapshot.
    if (this.destroyed) {
      try {
        controller.destroy();
      } catch {
        // best-effort: shutdown is in progress, swallow
      }
      throw new Error("HarnessLaneManager: destroyed during spawn; controller torn down");
    }

    // Register `onProcessExit` AFTER `createController` resolves —
    // `ACPSessionController` clears registered handlers at the top of
    // every `start()` call for race-safety. The factory contract is
    // that the returned controller has fully completed `start()`, so
    // the handler set is empty and ready to accept our subscription.
    //
    // NOTE: we intentionally do NOT track or call the exit-unsubscribe
    // handle. `controller.destroy()` triggers the synchronous child-kill;
    // the `exit` event fires on a later tick and the handler must still
    // be subscribed to observe it (so `child-exited` publishes correctly
    // and the slot's `ready` state stays accurate).
    controller.onProcessExit((info) => {
      this.handleProcessExit(slot, controller, info);
    });

    const unsubscribeSession = controller.subscribe((event: ACPSessionEvent) => {
      if (
        event.type === "mode_changed" ||
        event.type === "permission_gating_status" ||
        event.type === "config_option_changed"
      ) {
        this.maybePublishCardChanged(slot);
      }
    });

    slot.liveControllers.set(controller, { controller, unsubscribeSession });

    // First-spawn transition for this harness: flip `ready: false → true`
    // in place and publish `card-changed` so subscribers who only listen
    // to the card-invalidation signal (not `child-spawned`) see the
    // transition.
    const wasReady = slot.capability.ready;
    if (!wasReady) {
      const previousEntry: HarnessCapabilityEntry = { ...slot.capability, ready: false };
      slot.capability.ready = true;
      const newEntry: HarnessCapabilityEntry = { ...slot.capability };
      publishHarnessCardChanged(this.bus, {
        harnessId: slot.entry.id,
        previousEntry,
        newEntry,
      });
    }

    publishHarnessChildSpawned(this.bus, {
      harnessId: slot.entry.id,
      // Coerce `undefined` (mock has no real child) to `null` so the
      // field survives JSON.stringify on the /events SSE wire.
      pid: controller.getChildPid() ?? null,
      harnessDisplayName: slot.entry.displayName,
      capabilities: this.getHarnessCapabilityEntries(),
    });

    return controller;
  }

  /**
   * Tear down every currently-alive controller. Each `destroy()` triggers
   * a synchronous child-process kill; the child's `exit` event fires on
   * a later tick and the still-registered `onProcessExit` listener
   * publishes the `child-exited` envelope with `crash: false` (per
   * `ACPSessionController`'s `destroyedByGateway` latch).
   *
   * `destroy()` is idempotent and rejects any subsequent
   * `getOrSpawnLane` calls. Callers awaiting `getOrSpawnLane` when
   * `destroy()` lands will see their controller destroyed and the
   * promise rejected with a shutdown error.
   */
  destroy(): void {
    this.destroyed = true;

    for (const slot of this.slots.values()) {
      // Snapshot the live set before iterating so the exit listeners
      // (which mutate `liveControllers` via `handleProcessExit`) can't
      // perturb iteration.
      const live = Array.from(slot.liveControllers.values());

      // Unsubscribe session-event listeners. We don't need
      // card-renegotiation events during shutdown — and leaving them
      // subscribed would leak the closure.
      for (const item of live) {
        try {
          item.unsubscribeSession();
        } catch {
          // best-effort
        }
      }

      // Kick destroy on each live controller. Exit listeners stay
      // subscribed (intentionally) so the resulting `exit` event still
      // publishes `child-exited` + `card-changed`.
      for (const item of live) {
        try {
          item.controller.destroy();
        } catch {
          // best-effort: a destroy() throwing on one lane must not
          // block teardown of the rest of the fleet.
        }
      }
    }
  }

  // -- Internal --

  /**
   * Exit observer for a single controller. Publishes `child-exited`,
   * removes the controller from the slot's live set, and — if this was
   * the LAST live controller for the harness — flips `ready: true → false`
   * and publishes `card-changed`. Sticky `ready: true` while any
   * controller is still alive matches the cache-invalidation contract:
   * federation peers should see the harness as available as long as
   * SOME session can route to it.
   */
  private handleProcessExit(
    slot: HarnessSlot,
    controller: GatewayHostController,
    info: ProcessExitInfo,
  ): void {
    publishHarnessChildExited(this.bus, {
      harnessId: slot.entry.id,
      // Coerce `undefined` → `null` for JSON.stringify wire survival.
      pid: info.pid ?? null,
      exitCode: info.exitCode,
      signal: info.signal,
      crash: info.crash,
      durationMs: info.durationMs,
    });

    const item = slot.liveControllers.get(controller);
    if (item) {
      try {
        item.unsubscribeSession();
      } catch {
        // best-effort
      }
      slot.liveControllers.delete(controller);
    }

    // Ready transitions to false only when the LAST live controller
    // exits. Two-controller fleets where one crashes still see the
    // remaining one as ready.
    if (slot.liveControllers.size === 0 && slot.capability.ready) {
      const previousEntry: HarnessCapabilityEntry = { ...slot.capability };
      slot.capability.ready = false;
      const newEntry: HarnessCapabilityEntry = { ...slot.capability };
      publishHarnessCardChanged(this.bus, {
        harnessId: slot.entry.id,
        previousEntry,
        newEntry,
      });
    }
  }

  /**
   * Recompute the capability slice for `slot` against its tracked
   * `capability` mirror. In v1 the slice's shape (`id`, `displayName`,
   * `primary`, `ready`) doesn't reflect mode / config-option / gating
   * state, so for the events we listen to today this is effectively a
   * no-op diff. The hook is wired through anyway because `card-changed`
   * is the documented cache-invalidation signal for federated
   * peers; downstream additions to the slice (e.g. permission-mode
   * label) will flow through this path without further plumbing.
   */
  private maybePublishCardChanged(slot: HarnessSlot): void {
    const previousEntry: HarnessCapabilityEntry = { ...slot.capability };
    // No additional capability-slice mutation in v1. Recompute is a
    // structural identity until the slice gains derived fields.
    const newEntry: HarnessCapabilityEntry = { ...slot.capability };

    if (JSON.stringify(previousEntry) !== JSON.stringify(newEntry)) {
      publishHarnessCardChanged(this.bus, {
        harnessId: slot.entry.id,
        previousEntry,
        newEntry,
      });
    }
  }
}
