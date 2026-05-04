import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";

export function resolveHostWorkspaceFlag(runtime: ResolvedGatewayRuntime): string {
  return runtime.acp.workspaceFlag ?? "";
}
