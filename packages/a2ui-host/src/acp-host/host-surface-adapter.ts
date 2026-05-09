import type { A2uiMessage } from "@agents-js/a2ui-types";

export interface HostSurfaceAdapter {
  handleSurfaceMessage(message: A2uiMessage): Promise<void> | void;
  handleSurfaceClosed?(surfaceId: string): Promise<void> | void;
}
