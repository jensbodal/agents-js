/**
 * Terminal operation handlers for the ACP Client interface.
 * Implements create, output, release, waitForExit, kill, and destroyAll
 * with direct-exec-only policy.
 *
 * Each handler set is scoped to a TerminalManager instance, created via
 * `createTerminalHandlers()`. This ensures each ACPSessionController owns
 * its own terminal lifecycle.
 */

import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { validateTerminalRequest } from "@agents-js/policy";
import type { TerminalValidationResult } from "@agents-js/policy/terminal-policy";
import type { HostEnvPolicyInput } from "./env-policy.ts";
import { TerminalManager } from "./terminal-manager.ts";

export interface TerminalWorkspaceContext {
  validationRoot: string;
  defaultCwd: string;
}

export interface TerminalHandlers {
  create: (
    workspaceContext: TerminalWorkspaceContext,
    params: CreateTerminalRequest,
  ) => Promise<CreateTerminalResponse>;
  output: (params: TerminalOutputRequest) => Promise<TerminalOutputResponse>;
  release: (params: ReleaseTerminalRequest) => Promise<ReleaseTerminalResponse>;
  waitForExit: (params: WaitForTerminalExitRequest) => Promise<WaitForTerminalExitResponse>;
  kill: (params: KillTerminalRequest) => Promise<KillTerminalResponse>;
  destroyAll: () => void;
  getManager: () => TerminalManager;
}

export interface CreateTerminalHandlersOptions {
  envPolicy?: HostEnvPolicyInput;
}

/**
 * Create a scoped set of terminal handlers backed by a dedicated TerminalManager.
 * Each ACPSessionController should call this once and own the returned handlers.
 */
export function createTerminalHandlers(
  options: CreateTerminalHandlersOptions = {},
): TerminalHandlers {
  const terminalManager = new TerminalManager({ envPolicy: options.envPolicy });

  function requireWorkspaceContext(
    workspaceContext: TerminalWorkspaceContext,
  ): TerminalWorkspaceContext {
    if (!workspaceContext.validationRoot || !workspaceContext.defaultCwd) {
      throw RequestError.internalError(undefined, "Workspace path not available");
    }
    return workspaceContext;
  }

  function requireTerminal(terminalId: string): void {
    if (!terminalManager.getTerminal(terminalId)) {
      throw RequestError.resourceNotFound(terminalId);
    }
  }

  return {
    async create(
      workspaceContext: TerminalWorkspaceContext,
      params: CreateTerminalRequest,
    ): Promise<CreateTerminalResponse> {
      const { validationRoot, defaultCwd } = requireWorkspaceContext(workspaceContext);

      const validation: TerminalValidationResult = validateTerminalRequest(params, validationRoot);
      if (!validation.valid) {
        throw new RequestError(
          validation.jsonRpcCode ?? -32602,
          validation.reason ?? "Invalid terminal request",
        );
      }

      const terminalId = terminalManager.create(params, defaultCwd);
      return { terminalId };
    },

    async output(params: TerminalOutputRequest): Promise<TerminalOutputResponse> {
      requireTerminal(params.terminalId);

      const { output, truncated, exitStatus } = terminalManager.getOutput(params.terminalId);

      return {
        output,
        truncated,
        exitStatus: exitStatus
          ? {
              exitCode: exitStatus.exitCode,
              signal: exitStatus.signal,
            }
          : null,
      };
    },

    async release(params: ReleaseTerminalRequest): Promise<ReleaseTerminalResponse> {
      requireTerminal(params.terminalId);
      terminalManager.release(params.terminalId);
      return {};
    },

    async waitForExit(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
      requireTerminal(params.terminalId);

      const result = await terminalManager.waitForExit(params.terminalId);
      return {
        exitCode: result.exitCode,
        signal: result.signal,
      };
    },

    async kill(params: KillTerminalRequest): Promise<KillTerminalResponse> {
      requireTerminal(params.terminalId);
      terminalManager.kill(params.terminalId);
      return {};
    },

    destroyAll(): void {
      terminalManager.destroyAll();
    },

    getManager(): TerminalManager {
      return terminalManager;
    },
  };
}
