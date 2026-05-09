/**
 * Terminal security policy -- direct-exec only, no shell wrappers.
 *
 * Validates CreateTerminalRequest parameters before any process is spawned.
 * Hosts call this before delegating to their terminal adapter.
 *
 * Consolidated from earlier host-policy implementations.
 * Uses cross-platform path handling via shared path-utils.
 */

import type { CreateTerminalRequest } from "@agentclientprotocol/sdk";
import { isWithinWorkspace } from "./path-utils.ts";
import { SHELL_COMMANDS } from "./permission-types.ts";

export type TerminalValidationResult =
  | {
      valid: true;
    }
  | {
      valid: false;
      reason: string;
      /** JSON-RPC error code (-32602 for invalid params). */
      jsonRpcCode: number;
    };

/**
 * Characters permitted in terminal arguments. Anything outside this set
 * is rejected. Defense-in-depth — spawn() uses shell:false so most chars
 * are harmless, but an allowlist protects against future shell evaluation.
 */
const ALLOWED_ARG_CHARS = new Set<string>(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-=./@#%+:,_ '\"".split(""),
);

function isArgAllowed(arg: string): boolean {
  for (const ch of arg) {
    if (!ALLOWED_ARG_CHARS.has(ch)) return false;
  }
  return true;
}

function reject(reason: string): TerminalValidationResult {
  return { valid: false, reason, jsonRpcCode: -32602 };
}

/**
 * Validates a CreateTerminalRequest against the direct-exec-only policy.
 *
 * Rules:
 * 1. command must be a non-empty string
 * 2. command must not be a shell wrapper
 * 3. command must not contain path separators (prevents /bin/sh etc.)
 * 4. args must not contain disallowed characters
 * 5. cwd (if provided) must be equal to or under workspaceRoot
 */
export function validateTerminalRequest(
  params: CreateTerminalRequest,
  workspaceRoot: string,
): TerminalValidationResult {
  const command = params.command;

  // Rule 1: command must be a non-empty string
  if (!command || typeof command !== "string") {
    return reject("command must be a non-empty string");
  }

  // Rule 2: reject shell wrappers
  if (SHELL_COMMANDS.has(command.toLowerCase())) {
    return reject(`Shell command rejected: ${command}`);
  }

  // Rule 3: reject commands with path separators
  if (command.includes("/") || command.includes("\\")) {
    return reject(`Command must not contain path separators: ${command}`);
  }

  // Rule 4: reject args containing disallowed characters
  const args = params.args ?? [];
  for (const arg of args) {
    if (!isArgAllowed(arg)) {
      return reject(`Argument contains disallowed character: ${arg}`);
    }
  }

  // Rule 5: cwd must be within workspace root
  if (params.cwd != null && params.cwd !== "") {
    if (!isWithinWorkspace(workspaceRoot, params.cwd)) {
      return reject(`cwd is outside workspace root: ${params.cwd}`);
    }
  }

  // Rule 6: reject args containing absolute paths outside workspace root
  for (const arg of args) {
    if (arg.startsWith("/") && !isWithinWorkspace(workspaceRoot, arg)) {
      return reject(`Argument contains path outside workspace: ${arg}`);
    }
  }

  return { valid: true };
}
