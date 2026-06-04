/**
 * `@agents-js/agui-types` — canonical AG-UI types for the agents-js monorepo.
 *
 * Re-exports `@ag-ui/core@0.0.55` (pinned exact — pre-1.0) and adds
 * agents-js ↔ AG-UI adapter helpers that live in `./adapters/`.
 *
 * See `../README.md` for the adapter surface.
 */

// -- Canonical AG-UI SDK re-exports -------------------------------------------
// Covers: every `*Event` + `*EventSchema` + `*EventProps`, every `Message*`,
// `RunAgentInput` + `RunAgentInputSchema`, the full `AgentCapabilities` surface,
// `EventType`, `EventSchemas`, and error types.
export * from "@ag-ui/core";

// -- AG-UI Core schema version -------------------------------------------------
// Derived from the *installed* `@ag-ui/core/package.json` so this constant
// always tracks the actually-resolved version, regardless of whether the
// dependency is pinned exactly or routed through the workspace catalog.
import agUiCorePkg from "@ag-ui/core/package.json" with { type: "json" };

/**
 * The AG-UI Core schema version this package re-exports.
 *
 * Read from the installed `@ag-ui/core/package.json#version` at module load,
 * so it stays in sync with the dependency without any manual duplication.
 */
export const AGUI_CORE_VERSION: string = agUiCorePkg.version;

// -- agents-js ↔ AG-UI adapter helpers ----------------------------------------
export { type AguiBaseEventOptionals, pickAguiBaseOptionals } from "./adapters/base.ts";
export { type AgentsJsCustomInput, toAguiCustom } from "./adapters/custom.ts";
export {
  type AgentsJsMessageDeltaInput,
  type AgentsJsTextMessageEndInput,
  type AgentsJsTextMessageStartInput,
  toAguiTextMessageContent,
  toAguiTextMessageEnd,
  toAguiTextMessageStart,
} from "./adapters/message.ts";
export {
  type AgentsJsReasoningInput,
  toAguiReasoningEnd,
  toAguiReasoningStart,
} from "./adapters/reasoning.ts";
export {
  type AgentsJsRunErrorInput,
  type AgentsJsRunFinishedInput,
  toAguiRunError,
  toAguiRunFinished,
} from "./adapters/run.ts";
export {
  type AgentsJsToolCallArgsInput,
  type AgentsJsToolCallEndInput,
  type AgentsJsToolCallStartInput,
  toAguiToolCallArgs,
  toAguiToolCallEnd,
  toAguiToolCallStart,
} from "./adapters/tool-call.ts";

// -- Stateful AG-UI event-stream builder --------------------------------------
export {
  type AguiEventStream,
  type AguiEventStreamOptions,
  createAguiEventStream,
} from "./stream.ts";
