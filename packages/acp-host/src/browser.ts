/**
 * Browser-safe entry point for @agents-js/acp-host.
 *
 * The main entry (src/index.ts) re-exports the full host surface, which
 * transitively pulls in Node-only dependencies (filesystem adapters,
 * child-process helpers, MCP wiring, SDK runtime pieces) that cannot be
 * bundled for a browser target.
 *
 * Browser-bound consumers of this package today — notably the plugin
 * preview harness — only need a narrow constant + class + helper surface:
 *
 *   - `DEFAULT_AGENT_CONFIG`, `DEV_AGENT_CONFIG` from ./constants.ts
 *   - `Logger` from ./logger.ts
 *   - workflow-surface helpers from ./workflow-surfaces.ts
 *
 * All three source files are pure TS with type-only external imports, so
 * no Node polyfills are required to bundle this entry.
 *
 * Keep this entry minimal. If a new browser consumer starts needing more
 * of the host surface, add the narrowest re-export here; do NOT reach for
 * `./index.ts`, which carries Node-only transitive deps.
 */

export { DEFAULT_AGENT_CONFIG, DEV_AGENT_CONFIG } from "./constants.ts";
export type {
  LogCategory,
  LogEntry,
  LoggerConfig,
  LogLevel,
  LogTransport,
} from "./logger.ts";
export { Logger } from "./logger.ts";
export {
  collectToolCallStats,
  deriveWorkflowSurfaceState,
  describeWorkflowError,
  formatToolCallStatus,
  getTrailingToolBlockStats,
  summarizeToolGroup,
} from "./workflow-surfaces.ts";
