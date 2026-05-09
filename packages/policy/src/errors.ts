/**
 * Error helpers for ACP policy decisions.
 *
 * Returns code + message pairs that hosts can pass to
 * `new RequestError(code, message)` from @agentclientprotocol/sdk.
 */

export interface PolicyErrorInfo {
  code: number;
  message: string;
}

/**
 * Error for a policy violation -- the request is structurally valid but blocked by policy.
 *
 * Uses the reserved server-error range rather than `-32600`, which is reserved
 * for malformed JSON-RPC requests.
 */
export function policyError(reason: string): PolicyErrorInfo {
  return { code: -32000, message: reason };
}

/** Error for a validation failure -- the request parameters are invalid. */
export function validationError(reason: string): PolicyErrorInfo {
  return { code: -32602, message: reason };
}
