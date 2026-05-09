/**
 * Controller adapter configuration builder extracted from ACPSessionController.
 *
 * Builds the `ACPHostAdapters` object (file, terminal, elicitation, permission,
 * and session-update adapters) that gets passed to `new ACPClientController(...)`.
 */
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { ACPHostAdapters } from "@agents-js/acp";
import type { TerminalHandlers, TerminalWorkspaceContext } from "./terminal-handlers.ts";
import type { HostElicitationAdapter, HostFileAdapters } from "./types/adapters.ts";

export interface ControllerAdapterContext {
  requestPermission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  handleSessionUpdate: (notification: SessionNotification) => void;
  fileAdapters: HostFileAdapters | null;
  requestWriteGateApproval: (gate: {
    path: string;
    diff: string;
    absolutePath?: string;
  }) => Promise<boolean>;
  terminalHandlers: TerminalHandlers;
  terminalWorkspaceContext: TerminalWorkspaceContext;
  elicitationAdapter: HostElicitationAdapter | null;
  handleElicitationRequest: (
    request: CreateElicitationRequest,
  ) => Promise<CreateElicitationResponse>;
}

/**
 * Build the `ACPHostAdapters` config object for `ACPClientController`.
 *
 * Wires each adapter closure to the session controller's internal handlers
 * without exposing the full controller instance.
 */
export function buildControllerAdapters(ctx: ControllerAdapterContext): ACPHostAdapters {
  return {
    requestPermission: (request) => ctx.requestPermission(request),
    sessionUpdate: async (notification) => {
      ctx.handleSessionUpdate(notification);
    },
    fs: {
      readTextFile: (params) => {
        if (!ctx.fileAdapters) throw new Error("File adapters not configured");
        return ctx.fileAdapters.readTextFile(params);
      },
      writeTextFile: (params) => {
        if (!ctx.fileAdapters) throw new Error("File adapters not configured");
        return ctx.fileAdapters.writeTextFile(params, (gate) => ctx.requestWriteGateApproval(gate));
      },
    },
    terminal: {
      create: (params) => ctx.terminalHandlers.create(ctx.terminalWorkspaceContext, params),
      output: (params) => ctx.terminalHandlers.output(params),
      release: (params) => ctx.terminalHandlers.release(params),
      waitForExit: (params) => ctx.terminalHandlers.waitForExit(params),
      kill: (params) => ctx.terminalHandlers.kill(params),
    },
    elicitation: {
      request: (params) => ctx.handleElicitationRequest(params),
      complete: ctx.elicitationAdapter?.complete
        ? (params) => ctx.elicitationAdapter?.complete?.(params) ?? Promise.resolve()
        : undefined,
      capabilities: ctx.elicitationAdapter?.capabilities ?? { form: {} },
    },
  };
}
