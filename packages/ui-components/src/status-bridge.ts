export function deriveDisplayedSessionStatus(
  controllerStatus: string,
  hostSessionStatus?: string | null,
): string {
  switch (hostSessionStatus) {
    case "initializing":
    case "loading":
      return "connecting";
    case "ready":
      return "connected";
    case "prompting":
    case "cancelling":
      return "waiting";
    case "waiting_permission":
    case "waiting_elicitation":
      return "input_required";
    case "error":
      return "error";
    case "idle":
    case "closed":
      return "idle";
    default:
      return controllerStatus;
  }
}
