/**
 * Gateway-side surface broadcaster.
 *
 * Sits between the gateway's A2UI tool-call content handler and the
 * WebSocket bridge. The handler hands each validated {@link A2uiMessage}
 * (CreateSurface / UpdateComponents / UpdateDataModel / DeleteSurface)
 * to {@link GatewaySurfaceBroadcaster.handleSurfaceMessage}; the
 * broadcaster forwards it to the WS fan-out callback once
 * {@link GatewaySurfaceBroadcaster.attach} has wired one.
 *
 * ## Wiring invariant
 *
 * The gateway constructs the broadcaster, then the host session (which
 * wires it into the A2UI tool-call content handler), then the WS bridge
 * (which calls `attach`). The ACP agent does not run until a client
 * prompts it, which cannot happen before the WS bridge is up — so by
 * construction `handleSurfaceMessage` is never called before `attach`.
 * A message arriving without an attached broadcaster signals a broken
 * wiring order and is logged and dropped.
 *
 * Messages arriving upstream are already validated by
 * `packages/acp-host/src/session-updates.ts` before they reach
 * `SurfaceSession.apply()`, so this class does NOT re-validate. Belt +
 * suspenders validation happens again at the browser ingress inside
 * `A2uiHost.applyMessage`.
 *
 * ## Reconnects
 *
 * The broadcaster does NOT replay previously-sent messages to new WS
 * clients. A reconnecting browser sees empty surface state until the
 * next agent update. Full replay is outside this broadcaster's
 * contract because it would require retaining every message for the
 * session lifetime and coordinating with surface teardown.
 */

import type { HostSurfaceAdapter } from "@agents-js/a2ui-host/acp-host";
import type { A2uiMessage } from "@agents-js/a2ui-types";

/** Fan-out callback handed to the broadcaster by the WS bridge. */
export type SurfaceBroadcastFn = (message: A2uiMessage) => void;

/**
 * Adapter that plugs into the ACP host session and, once attached to a
 * live broadcaster, forwards every lifecycle message to that broadcaster.
 */
export interface GatewaySurfaceBroadcaster extends HostSurfaceAdapter {
  /**
   * Register the fan-out callback. Calling `attach` a second time
   * replaces the previous broadcaster; the new callback receives every
   * message that arrives after the swap.
   */
  attach(broadcast: SurfaceBroadcastFn): void;
}

export interface GatewaySurfaceBroadcasterConfig {
  /**
   * Logger invoked when `handleSurfaceMessage` runs with no broadcaster
   * attached. That path indicates a wiring-order bug (see the module
   * header's invariant); surface it loudly so misconfigured setups
   * don't silently swallow messages. Defaults to `console.warn`.
   */
  onUnattached?: (message: A2uiMessage) => void;
}

export function createGatewaySurfaceBroadcaster(
  config: GatewaySurfaceBroadcasterConfig = {},
): GatewaySurfaceBroadcaster {
  const onUnattached =
    config.onUnattached ??
    ((message: A2uiMessage) => {
      console.warn(
        "[surface-broadcaster] handleSurfaceMessage called before attach(); dropping A2UI message",
        message,
      );
    });
  let broadcast: SurfaceBroadcastFn | null = null;

  return {
    handleSurfaceMessage(message: A2uiMessage): void {
      if (!broadcast) {
        onUnattached(message);
        return;
      }
      broadcast(message);
    },

    // Agent-initiated DeleteSurface flows through handleSurfaceMessage; the
    // no-op here exists only to satisfy the optional hook invoked when the
    // host tears down a surface locally (e.g. during session shutdown).
    handleSurfaceClosed(): void {},

    attach(fn: SurfaceBroadcastFn): void {
      broadcast = fn;
    },
  };
}
