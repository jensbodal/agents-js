import {
  type GatewayRuntimeDefinition,
  type ResolvedGatewayRuntime,
  type RuntimeCommandResolver,
  resolveGatewayRuntime as resolveSharedGatewayRuntime,
  resolveGatewayRuntimeCommand as resolveSharedGatewayRuntimeCommand,
} from "@agents-js/gateway-runtime";

export function resolveGatewayRuntimeCommand(
  definition: GatewayRuntimeDefinition,
  resolver?: RuntimeCommandResolver,
): Promise<string> {
  return resolveSharedGatewayRuntimeCommand(definition, {
    resolver,
    workspaceBinRoot: import.meta.dir,
  });
}

export function resolveGatewayRuntime(
  runtimeId: string,
  resolver?: RuntimeCommandResolver,
): Promise<ResolvedGatewayRuntime> {
  return resolveSharedGatewayRuntime(runtimeId, {
    resolver,
    workspaceBinRoot: import.meta.dir,
  });
}
