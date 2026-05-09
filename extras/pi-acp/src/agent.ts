/**
 * ACP `Agent` factory for the pi-acp wrapper. The binary entry point in
 * `bin.ts` wires this into `runAcpWrapperBinary` from `@agents-js/acp`.
 */
import {
  type Agent,
  type AgentSideConnection,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { extractPromptText } from "@agents-js/acp";
import { PiAcpSession } from "./session.ts";

export interface PiAcpAgentInfo {
  name: string;
  version: string;
}

export function createPiAcpAgent(
  agentInfo: PiAcpAgentInfo,
): (connection: AgentSideConnection, piArgs: readonly string[]) => Agent {
  return (connection, piArgs) => {
    const sessions = new Map<string, PiAcpSession>();
    let counter = 0;

    return {
      async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo,
          // Capabilities are intentionally minimal in the first cut:
          //   - no loadSession / session.fork / session.resume / session.close
          //   - no prompt tools beyond the baseline text content
          // Adding them is future work once the corresponding Pi RPC surfaces
          // are wired through the translator.
          agentCapabilities: {},
          authMethods: [],
        };
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        counter += 1;
        // Deterministic, stream-local id — Pi keeps its own per-process id;
        // ACP clients only care that the id is unique within this connection.
        const sessionId = `pi-acp-session-${counter}`;
        const session = new PiAcpSession({
          sessionId,
          connection,
          cwd: params.cwd,
          piExtraArgs: piArgs,
        });
        sessions.set(sessionId, session);
        return { sessionId };
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        const session = sessions.get(params.sessionId);
        if (!session) {
          throw new Error(`[pi-acp] Unknown sessionId: ${params.sessionId}`);
        }
        const message = extractPromptText(params);
        const { stopReason } = await session.prompt(message);
        return { stopReason };
      },

      async cancel(params: CancelNotification): Promise<void> {
        const session = sessions.get(params.sessionId);
        if (!session) return;
        session.cancel();
      },

      async authenticate() {
        // Pi manages provider auth internally via its `/login` TUI; there is
        // no ACP-layer credential exchange. Returning void satisfies the
        // optional-on-agent contract for clients that call authenticate blindly.
        return {};
      },
    };
  };
}
