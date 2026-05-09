/**
 * ACP `Agent` factory for the droid-acp wrapper. The binary entry point in
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
import { DroidAcpSession } from "./session.ts";

export interface DroidAcpAgentInfo {
  name: string;
  version: string;
}

export function createDroidAcpAgent(
  agentInfo: DroidAcpAgentInfo,
): (connection: AgentSideConnection, droidArgs: readonly string[]) => Agent {
  return (connection, droidArgs) => {
    const sessions = new Map<string, DroidAcpSession>();
    let counter = 0;

    return {
      async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo,
          // Minimal capability surface for v1:
          //   - no loadSession / session.fork / session.resume / session.close
          //   - no permission prompting (droid manages its own autonomy levels)
          //   - no fs/terminal bridging (droid runs its own sandbox)
          // Future work once ACP <-> droid surfaces align further.
          agentCapabilities: {},
          authMethods: [],
        };
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        counter += 1;
        // Deterministic, stream-local id — droid's own session id is captured
        // separately and reused for turn continuity via `--session-id`.
        const sessionId = `droid-acp-session-${counter}`;
        const session = new DroidAcpSession({
          sessionId,
          connection,
          cwd: params.cwd,
          droidExtraArgs: droidArgs,
        });
        sessions.set(sessionId, session);
        return { sessionId };
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        const session = sessions.get(params.sessionId);
        if (!session) {
          throw new Error(`[droid-acp] Unknown sessionId: ${params.sessionId}`);
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
        // Droid manages provider credentials via FACTORY_API_KEY and its local
        // credential cache. No ACP-layer credential exchange is needed.
        return {};
      },
    };
  };
}
