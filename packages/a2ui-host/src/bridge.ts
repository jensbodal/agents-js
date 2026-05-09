/**
 * A2UI bridge between a transport and an {@link A2uiHost}.
 *
 * Two directions:
 *
 *   agent -> host :  inbound A2UI lifecycle messages (CreateSurface /
 *                    UpdateComponents / UpdateDataModel / DeleteSurface).
 *                    Callers feed each one into {@link A2uiBridge.applyInbound}
 *                    which routes to {@link A2uiHost.applyMessage}. In the
 *                    web-ui this is driven by the gateway WS bridge; in
 *                    obsidian-acp-plugin it is driven by
 *                    ACP tool-call content handlers can forward messages
 *                    through the `@agents-js/a2ui-host/acp-host` subpath.
 *
 *   host -> agent :  user-driven events emitted by rendered primitives
 *                    (`A2uiHost.onEvent(surfaceId, actionName, payload)`).
 *                    The bridge forwards these upstream via the
 *                    `sendSurfaceEvent` callback supplied through
 *                    {@link SurfaceEventSink}.
 *
 * ## Hot-reload lifetime
 *
 * The bridge is designed to outlive the host. Hosts are tied to a mount
 * element and may be reconstructed across HMR / leaf-revival cycles.
 * {@link attachHost} returns the previously-attached host (if any) so the
 * caller can detect and dispose a displaced host. {@link detachHost} only
 * clears the slot when the caller's host still owns it — preventing a
 * retiring host from nulling a freshly-attached replacement during a
 * revival race. Inbound messages that arrive without an attached host are
 * dropped silently; messages that arrive after the host is destroyed are
 * dropped and warned (operator-visible diagnostic).
 *
 * ## Back-channel gap
 *
 * A2UI v0.9 does not standardize the surface-event back-channel. The sink
 * is intentionally opaque so consumers can wire any transport (HTTP POST,
 * ACP `surface_event`, in-memory log-and-drop) without the bridge
 * carrying knowledge of the wire shape.
 */

import type { A2uiMessage } from "@agents-js/a2ui-types";
import { A2uiHost, type A2uiHostEventHandler, type A2uiHostOptions } from "./host.ts";

/**
 * Minimal shape of a sink that can ferry surface events back to the agent.
 *
 * The `<P>` generic narrows the payload envelope. Consumers that know their
 * wire contract at the wiring site can narrow once here and have their
 * `sendSurfaceEvent` implementation typecheck against that shape end-to-end.
 * Defaults to `Record<string, unknown>` for source compat.
 */
export interface SurfaceEventSink<P = Record<string, unknown>> {
  /**
   * Called when a rendered primitive emits a user action. Implementations
   * typically route this over the wire (HTTP POST, ACP `surface_event`,
   * etc.). The payload shape is intentionally opaque (A2UI v0.9 does not
   * standardize a back-channel schema).
   */
  sendSurfaceEvent(surfaceId: string, actionName: string, payload: P): void;
}

/** Options for constructing an {@link A2uiBridge}. */
export interface A2uiBridgeOptions<P = Record<string, unknown>> {
  /**
   * Destination for user-driven surface events. Required — every real
   * consumer (apps/web-ui main, obsidian-acp-plugin session-lifecycle)
   * supplies one unconditionally, so the previous optional shape existed
   * only to humor a hypothetical caller that never materialized. Pass a
   * no-op `{ sendSurfaceEvent: () => {} }` if you explicitly want to drop
   * events on the floor for a local smoke path — making the drop explicit
   * is the point.
   */
  readonly sink: SurfaceEventSink<P>;
  /**
   * Optional observer for inbound messages that the bridge drops before
   * they reach a host. Fired at both drop sites — the silent no-host
   * drop and the warn-and-drop for a destroyed host — with a reason
   * tag so telemetry / tests can distinguish them. Additive: the
   * existing `console.warn` for the destroyed-host case still fires.
   */
  readonly onInboundDrop?: (reason: "no-host" | "host-destroyed", message: A2uiMessage) => void;
}

/**
 * Wires an {@link A2uiHost} onto a transport. The bridge owns no host state
 * of its own — it is pure glue.
 */
export class A2uiBridge<P = Record<string, unknown>> {
  private host: A2uiHost<P> | null;
  private sink: SurfaceEventSink<P>;
  private readonly onInboundDrop?: (
    reason: "no-host" | "host-destroyed",
    message: A2uiMessage,
  ) => void;
  // Pre-bound forwarder — stable reference so callers can pass it directly
  // to `new A2uiHost({ onEvent })` and keep wiring linear when bridge and
  // host need to be constructed in a cycle (bridge first to capture
  // `onEvent`, then host with that `onEvent`, then `bridge.attachHost(host)`).
  readonly onEvent: A2uiHostEventHandler<P>;

  constructor(opts: A2uiBridgeOptions<P>) {
    this.host = null;
    this.sink = opts.sink;
    this.onInboundDrop = opts.onInboundDrop;
    this.onEvent = (surfaceId, actionName, payload) => {
      this.sink.sendSurfaceEvent(surfaceId, actionName, payload);
    };
  }

  /**
   * Construct an {@link A2uiHost} pre-wired to this bridge's `onEvent`
   * sink. Preferred over constructing {@link A2uiHost} directly — the
   * wiring cycle (bridge `onEvent` into host constructor) is typo-proof
   * here, and a wrong `onEvent` can silently defeat the sink path without
   * any type-level complaint.
   *
   * Caller still must call {@link attachHost} after receiving the
   * instance — factory construction and slot attachment are kept separate
   * so the attach step stays identity-checked against hot-reload races.
   */
  createHost(mount: HTMLElement, opts: Omit<A2uiHostOptions<P>, "onEvent">): A2uiHost<P> {
    return new A2uiHost<P>(mount, { ...opts, onEvent: this.onEvent });
  }

  /**
   * Attach `host` as the inbound target. Returns the previous host (or
   * `null` if none), letting the caller detect and dispose a displaced
   * host if hot-reload / leaf-revival races mount a new view before the
   * retiring one finishes tearing down.
   *
   * Throws if `host.isDestroyed` is already `true` — attaching a dead host
   * would produce a zombie slot that passes {@link isHostAttached} but
   * silently drops every inbound message. Callers must construct a fresh
   * host before reattaching.
   *
   * @returns the displaced host, or `null` if the slot was empty. Caller
   *   OWNS the displaced host — they must `destroy()` it or hand it off to
   *   a new owner. Ignoring this return leaks the previous host's
   *   `MessageProcessor` and the DOM subtree rooted at its mount element.
   */
  attachHost(host: A2uiHost<P>): A2uiHost<P> | null {
    if (host.isDestroyed) {
      throw new Error("[a2ui-bridge] cannot attach a destroyed host");
    }
    const previous = this.host ?? null;
    this.host = host;
    return previous;
  }

  /**
   * Detach only if the currently-attached host matches — prevents a stale
   * retiring view from nulling a freshly attached host during hot-reload.
   * Returns `true` when the field was cleared, `false` if the caller's
   * host reference was already displaced.
   */
  detachHost(host: A2uiHost<P>): boolean {
    if (this.host !== host) return false;
    this.host = null;
    return true;
  }

  /** Current attached host, or `null` if none. Read-only window for callers. */
  getHost(): A2uiHost<P> | null {
    return this.host;
  }

  /**
   * Whether a host is currently attached. Consumers use this to distinguish
   * "teardown torn down an active host" from "teardown ran but nothing was
   * attached" (e.g. the obsidian-acp-plugin demo command's cosmetic Notice
   * copy). Kept as a separate boolean-returning method alongside
   * {@link getHost} so callers can express intent without pulling a live
   * reference they do not need.
   *
   * Returns `true` for a slot-bound host even if `host.isDestroyed`; use
   * {@link isHostLive} when liveness (can actually receive messages)
   * matters.
   */
  isHostAttached(): boolean {
    return this.host !== null;
  }

  /**
   * Returns `true` only when a host is attached AND not destroyed. Use
   * this instead of {@link isHostAttached} when callers need to know
   * whether the attached host can actually receive messages — e.g. the
   * plugin's teardown UX uses this to avoid reporting success for a
   * destroyed-but-attached zombie host.
   */
  isHostLive(): boolean {
    return this.host !== null && !this.host.isDestroyed;
  }

  /**
   * Push an inbound A2UI lifecycle message to the host. Exposed so the
   * caller can ferry messages without the bridge having to know which
   * transport produced them. Silently dropped when no host is attached;
   * warned-and-dropped when the attached host has already been destroyed.
   * Both drop paths also fan out to the optional
   * `onInboundDrop` observer atomically with the drop — use that hook
   * instead of polling `isHostLive()` from outside, which races.
   *
   * The parameter is typed `A2uiMessage` rather than `unknown` so the
   * type system enforces pre-validated payloads. {@link A2uiHost.applyMessage}
   * still runs `validateA2uiMessage` internally as a final defense-in-depth
   * gate against wire-level corruption — the bridge only tightens the
   * compile-time contract.
   */
  applyInbound(message: A2uiMessage): void {
    if (!this.host) {
      this.onInboundDrop?.("no-host", message);
      return;
    }
    if (this.host.isDestroyed) {
      // Rare: a message arrived between host.destroy() and bridge.detachHost().
      // The drop is intentional — but log so operators can see drop counts
      // when debugging hot-reload lifecycle issues.
      console.warn("[a2ui-bridge] Dropping inbound message — host already destroyed");
      this.onInboundDrop?.("host-destroyed", message);
      return;
    }
    this.host.applyMessage(message);
  }

  /** Swap the outbound sink at runtime (e.g. after transport reconnect). */
  setSink(sink: SurfaceEventSink<P>): void {
    this.sink = sink;
  }
}
