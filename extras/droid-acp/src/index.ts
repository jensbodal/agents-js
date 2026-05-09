/**
 * Public exports of `@agents-js/droid-acp`.
 *
 * The primary consumer is the compiled `droid-acp` binary, but the building
 * blocks are exposed so embedders and tests can instantiate the translator
 * or the exec client directly.
 */
export {
  buildDroidExecArgs,
  DroidExecClient,
  type DroidExecClientOptions,
} from "./droid-exec-client.ts";
export { DroidAcpSession, type DroidAcpSessionOptions } from "./session.ts";
export {
  DroidToAcpTranslator,
  type DroidTranslatorStepResult,
  promptRequestToDroidPrompt,
  stripInlineThinking,
} from "./translator.ts";
export {
  DROID_EVENT_TYPES,
  type DroidCompletionEvent,
  type DroidMessageEvent,
  type DroidReasoningEvent,
  type DroidStreamEvent,
  type DroidSystemEvent,
  type DroidToolCallEvent,
  type DroidToolResultEvent,
  isDroidCompletionEvent,
  isDroidSystemEvent,
} from "./types.ts";
