/**
 * Stable public facade for gateway runtime lookup, command resolution,
 * profile application, selection dispatch, and ACP-entry bridging.
 *
 * The implementations are split by responsibility:
 * - `runtime-command-resolution.ts` owns package-bin discovery, PATH probing,
 *   and absolute/relative command resolution.
 * - `runtime-selection.ts` owns curated/custom runtime selection and profile
 *   application.
 * - `acp-agent-entry-runtime.ts` owns ACP registry-entry bridging.
 * - `runtimes-registry.ts` owns declarative curated runtime metadata.
 */
// biome-ignore lint/performance/noBarrelFile: this module is the stable public facade for the split runtime implementation.
export { resolveAcpAgentEntryToRuntime } from "./acp-agent-entry-runtime.ts";
export { buildExtendedPath, resolveGatewayRuntimeCommand } from "./runtime-command-resolution.ts";
export {
  applyGatewayRuntimeProfile,
  detectInstalledGatewayRuntimes,
  getGatewayRuntimeDefinition,
  listGatewayRuntimeIds,
  resolveGatewayRuntime,
  resolveGatewayRuntimeProfile,
  resolveGatewayRuntimeSelection,
  resolveRuntimeArgs,
  validateGatewayRuntimeProfileName,
} from "./runtime-selection.ts";
