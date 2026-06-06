/**
 * Public exports of `@agents-js/pi-acp`.
 *
 * The primary consumer is the compiled `pi-acp` binary, but the building
 * blocks are exposed so embedders and tests can instantiate the translator
 * or the RPC client directly.
 */
export { PiRpcClient, type PiRpcClientOptions } from "./pi-rpc-client.ts";
export { PiAcpSession, type PiAcpSessionOptions } from "./session.ts";
export { PiToAcpTranslator, type TranslatorStepResult } from "./translator.ts";
export {
  isPiRpcResponse,
  PI_ASSISTANT_EVENT_TYPES,
  PI_EVENT_TYPES,
  type PiRpcEvent,
  type PiRpcMessage,
  type PiRpcRequest,
  type PiRpcResponse,
} from "./types.ts";
