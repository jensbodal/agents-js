export {
  type ACPProcess,
  type ACPProcessOptions,
  buildSpawnEnv,
  CLIENT_METHODS,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
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
