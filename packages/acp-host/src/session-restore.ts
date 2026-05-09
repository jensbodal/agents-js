export const SESSION_RESTORE_FAILURE_MESSAGE =
  "Could not restore previous session (agent restarted or session lost). A new session was started instead.";

export function isSessionRestoreFailureMessage(message: string | null | undefined): boolean {
  return message === SESSION_RESTORE_FAILURE_MESSAGE;
}
