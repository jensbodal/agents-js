// !! Browser-safe barrel !!
// This index is consumed by the web-ui via Vite dev server.
// Do NOT re-export modules that depend on Node built-ins (node:fs, node:os, etc.)
// or the web-ui will crash at load time with:
//   Module "node:fs/promises" has been externalized for browser compatibility
//
// registry.ts uses node:fs/promises and node:os -- import it directly from
// server-side consumers, not through this barrel.

export {
  ACP_A2A_AUTH_REQUIRED_METADATA_KEY,
  ACP_A2A_ELICITATION_METADATA_KEY,
  ACP_A2A_ELICITATION_RESPONSE_METADATA_KEY,
  buildAcpElicitationResponseMetadata,
  extractAcpAuthRequiredMetadata,
  extractAcpElicitationMetadata,
} from "./acp-state.ts";
export {
  type AdaptedTarget,
  type AdaptTargetContext,
  adaptTarget,
  type RawAgentCard,
  type TargetAdapter,
} from "./adapters/target.ts";
export { A2AClientController, type A2AClientControllerOptions } from "./controller.ts";
export { createDebugFetch } from "./debug.ts";
export { applyJsonPatch } from "./json-patch.ts";
export type { ParsedDispatchDirective, ParsedMention } from "./mention-parser.ts";
export {
  parseAgentMentions,
  parseDispatchDirective,
  stripMention,
} from "./mention-parser.ts";
export type {
  A2ADelegationFramingTemplate,
  A2AMentionDispatchError,
  A2AMentionDispatchOptions,
  A2AMentionDispatchSuccess,
  A2AMentionResponseBlockOptions,
  AgentMentionMap,
  AgentMentionRegistry,
  AgentMentionResolver,
  CreateA2AMentionMiddlewareOptions,
} from "./middleware.ts";
export {
  A2A_DELEGATION_FRAMING_TEMPLATE,
  A2A_DELEGATION_RESPONSE_CLOSE_TAG,
  A2A_DELEGATION_RESPONSE_OPEN_TAG,
  buildA2ADelegationFramingText,
  createA2AMentionMiddleware,
  escapeA2ADelegationInnerText,
  extractA2AResponseText,
} from "./middleware.ts";
export { A2AClientProvider } from "./provider.ts";
export {
  collectTextParts,
  createInitialSessionState,
  extractLatestAgentMessage,
  extractLatestAgentText,
  extractMessageText,
  isTerminalTaskState,
  reduceA2ASessionState,
} from "./session.ts";
export { describeSessionStatus } from "./session-view-model.ts";
export {
  type NormalizedAgentTargetInput,
  normalizeAgentTargetInput,
  normalizeHeaders,
  originCardFallback,
  summarizeCapabilities,
  truncateText,
} from "./target.ts";
export {
  type DiscoveredTarget,
  type DiscoveredTargetGroup,
  type GroupDiscoveredTargetsOptions,
  groupDiscoveredTargets,
  type TargetReachability,
} from "./target-discovery.ts";
export { SdkA2ATransport } from "./transport.ts";
export {
  type AGUIRunResult,
  AGUITransport,
  type AGUITransportOptions,
} from "./transports/agui.ts";
export { AguiToA2ATransportAdapter } from "./transports/agui-a2a-adapter.ts";
export { AGUIStreamError, AGUIUnsupportedOperationError } from "./transports/agui-errors.ts";
export { parseAguiSseStream } from "./transports/agui-sse-parser.ts";
export type {
  A2AAbortSendEvent,
  A2AAbortStreamEvent,
  A2AAuthRequiredState,
  A2AAvailableCommandsUpdatedEvent,
  A2ACancellationFailedEvent,
  A2ACancellationRequestedEvent,
  A2ACancellationSucceededEvent,
  A2ACustomEvent,
  A2AEvent,
  A2AEventListener,
  A2AMessageEndEvent,
  A2AMessageStartEvent,
  A2AModeChangedEvent,
  A2APlanUpdatedEvent,
  A2AReasoningEncryptedEvent,
  A2AReasoningEndEvent,
  A2AReasoningMessageChunkEvent,
  A2AReasoningMessageContentEvent,
  A2AReasoningMessageEndEvent,
  A2AReasoningMessageStartEvent,
  A2AReasoningStartEvent,
  A2ARequestSentEvent,
  A2ARunErrorEvent,
  A2ARunFinishedEvent,
  A2ARunStartedEvent,
  A2ASendResult,
  A2ASessionInfoUpdatedEvent,
  A2ASessionState,
  A2ASessionUpdatedEvent,
  A2AStepFinishedEvent,
  A2AStepStartedEvent,
  A2AStreamClosedEvent,
  A2AStreamEvent,
  A2AStreamFirstEventEvent,
  A2AStreamIdleEvent,
  A2AStreamLastEventEvent,
  A2AStreamOpenedEvent,
  A2AToolCallArgsEvent,
  A2AToolCallEndEvent,
  A2AToolCallProgressEvent,
  A2AToolCallStartEvent,
  A2ATransport,
  A2AUsageUpdatedEvent,
  ACPA2AElicitation,
  ACPA2AElicitationContentValue,
  ACPA2AElicitationResponse,
  ACPA2AElicitationSchema,
  AgentTargetInput,
  CancelTaskOptions,
  CancelTaskResult,
  CapabilitySummary,
  DebugRecord,
  JsonPatchOperation,
  ProbeResult,
  ResolvedAgentTarget,
  ResumeTurnOptions,
  SendTurnOptions,
  SessionStatus,
  SessionStatusAction,
  SessionStatusViewModel,
  TargetInspection,
  TargetInspectionStatus,
  TranscriptEntry,
} from "./types.ts";
export { randomUuid } from "./uuid.ts";
