import type { RuntimeSwitchState } from "./ws-client.ts";

export function deriveRuntimeNotice(
  showHostState: boolean,
  runtimeSwitchState?: RuntimeSwitchState | null,
): string {
  if (!showHostState || !runtimeSwitchState?.status) {
    return "";
  }

  if (
    runtimeSwitchState.status === "runtimeApplied" &&
    runtimeSwitchState.clearedPendingTurn !== true
  ) {
    return "";
  }

  return runtimeSwitchState.message;
}
