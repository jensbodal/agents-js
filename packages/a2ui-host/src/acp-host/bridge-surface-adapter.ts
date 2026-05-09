import type { A2uiMessage } from "@agents-js/a2ui-types";
import type { A2uiBridge } from "../bridge.ts";
import type { HostSurfaceAdapter } from "./host-surface-adapter.ts";

/**
 * Build a {@link HostSurfaceAdapter} that forwards every incoming A2UI
 * lifecycle message through the given bridge. Pass the returned adapter
 * into `createA2uiToolCallContentHandler({ surfaceAdapter })` and register
 * the resulting handler on the consumer's ACP session controller.
 */
export function createBridgeSurfaceAdapter<P = Record<string, unknown>>(
  bridge: A2uiBridge<P>,
): HostSurfaceAdapter {
  return {
    handleSurfaceMessage(message: A2uiMessage): void {
      bridge.applyInbound(message);
    },
    handleSurfaceClosed(_surfaceId: string): void {
      // Explicit no-op: MessageProcessor handles DeleteSurface natively via
      // `applyMessage`, so nothing extra is needed today. Override here if
      // a consumer ever needs per-surface cleanup (telemetry, elicitation
      // cancel, etc.) -- the grep hit lands in a known place.
    },
  };
}
