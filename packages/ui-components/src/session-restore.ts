import { isSessionRestoreFailureMessage } from "@agents-js/acp-host/session-restore";
import type { HostState } from "./ws-client.ts";

export function shouldClearStaleSessionHash(
  hostState: HostState,
  pendingRestoreSessionId: string | null,
): boolean {
  return (
    pendingRestoreSessionId !== null &&
    !hostState.sessionId &&
    isSessionRestoreFailureMessage(hostState.lastError)
  );
}
