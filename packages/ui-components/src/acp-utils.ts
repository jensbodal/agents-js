/**
 * Maps a session status string to a semantic category for styling.
 */
export function statusCategory(status: string): "success" | "error" | "active" | "idle" {
  switch (status) {
    case "connected":
    case "completed":
      return "success";
    case "error":
      return "error";
    case "sending":
    case "waiting":
    case "connecting":
    case "input_required":
    case "auth_required":
      return "active";
    default:
      return "idle";
  }
}
