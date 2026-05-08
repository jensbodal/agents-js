// `@hostSurface` JSDoc tags travel with the original symbol declaration
// (in `controller.ts`, `connection.ts`, etc.), not with these re-exports.
// `scripts/docs-reference.ts` walks each package's source tree, finds
// declarations carrying the tag, and validates that the listed names are
// actually re-exported from this barrel — so renaming or removing a
// tagged symbol fails `bun run check` until the docs are regenerated.

export {
  type ACPProcess,
  type ACPProcessOptions,
  buildSpawnEnv,
  CLIENT_METHODS,
  RequestError,
  spawnACPAgent,
} from "./connection.ts";
export {
  ACPClientController,
  type ACPClientControllerOptions,
  type ACPClientState,
  type ACPControllerEvent,
  type ACPHostAdapters,
  type ACPWorkspaceRootPolicy,
} from "./controller.ts";
export { CwdResolutionError, resolveSessionCwd } from "./cwd-resolver.ts";
export { extractRequestErrorDetails, formatRequestError } from "./error-format.ts";
export {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "./host-surface-sdk.ts";
export { consoleLogSink, type LogSink } from "./log-sink.ts";
export { extractPromptText } from "./prompt-text.ts";
export { ResilientACPProcess } from "./resilience.ts";
export {
  createErrorAwareReadable,
  type ErrorAwareStreamOptions,
  type ErrorSignal,
} from "./stream-utils.ts";
export type {
  AuthenticateRequest,
  AuthenticateResponse,
  AuthMethod,
  ClientCapabilities,
  CloseSessionRequest,
  CloseSessionResponse,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationCapabilities,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeResponse,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  Stream,
} from "./types.ts";
export { type AcpWrapperBinarySpec, runAcpWrapperBinary } from "./wrapper-binary.ts";
