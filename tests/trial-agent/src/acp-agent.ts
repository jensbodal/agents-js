/**
 * Programmatic factory for the trial-agent ACP `Agent` implementation.
 *
 * Lifted out of `bin/trial-agent.ts` so the agent can be embedded in test
 * harnesses (or any other host that owns its own `AgentSideConnection`)
 * with explicit control over the document root rather than relying on
 * the binary's env-var + default fallback chain.
 *
 * The bin script is a thin wrapper: it parses CLI flags + env vars,
 * resolves the hub-root precedence (flag > env > default), then calls
 * {@link createTrialAgent} with the result.
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
import { DEFAULT_FETCH_CONTEXT_HUB_ROOT } from "@agents-js/tools";
import { createPromptHandler } from "./prompt-handler.ts";

export const TRIAL_AGENT_NAME = "trial-agent";
export const TRIAL_AGENT_VERSION = "0.2.0-beta-4";

/**
 * Default document root used when no override is supplied. Mirrors the
 * default baked into the `searchDocs` / `fetchContext` primitives in
 * `@agents-js/tools`. Exported so callers and tests can reference the
 * same canonical value rather than re-deriving it.
 */
export const DEFAULT_TRIAL_AGENT_HUB_ROOT = DEFAULT_FETCH_CONTEXT_HUB_ROOT;

/**
 * Options accepted by {@link createTrialAgent}. All fields are optional;
 * unspecified fields fall back to the trial-agent defaults.
 */
export interface CreateTrialAgentOptions {
  /**
   * Hub root passed to every `session/prompt` dispatch. When unset,
   * defaults to {@link DEFAULT_TRIAL_AGENT_HUB_ROOT}. Operators override
   * this to point the agent at fixture data or a different document layout.
   */
  hubRoot?: string;
  /**
   * Workspace-root override applied to every session regardless of the
   * `cwd` in `NewSessionRequest`. When unset, the agent uses
   * `params.cwd ?? process.cwd()` per the ACP-prescribed precedence.
   */
  workspaceRoot?: string;
}

interface TrialSession {
  id: string;
  workspaceRoot: string;
  hubRoot: string;
  cancelled: boolean;
}

function nextSessionId(counter: { value: number }): string {
  counter.value += 1;
  return `trial-agent-session-${counter.value}`;
}

/**
 * Build the trial-agent ACP {@link Agent} bound to the supplied connection.
 *
 * `options.hubRoot` is the lift target — operators can construct the agent
 * with any hub root rather than relying on the package default. When unset,
 * falls back to {@link DEFAULT_TRIAL_AGENT_HUB_ROOT}.
 */
export function createTrialAgent(
  connection: AgentSideConnection,
  options: CreateTrialAgentOptions = {},
): Agent {
  const sessions = new Map<string, TrialSession>();
  const counter = { value: 0 };
  const hubRoot = options.hubRoot ?? DEFAULT_TRIAL_AGENT_HUB_ROOT;
  const workspaceRootOverride = options.workspaceRoot;

  return {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: TRIAL_AGENT_NAME, version: TRIAL_AGENT_VERSION },
        // Minimal capability surface. The trial agent does not need fs,
        // terminal, elicitation, or permission prompting because every
        // primitive it wraps is local + read-only.
        agentCapabilities: {},
        authMethods: [],
      };
    },

    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      const sessionId = nextSessionId(counter);
      const workspaceRoot = workspaceRootOverride ?? params.cwd ?? process.cwd();
      sessions.set(sessionId, {
        id: sessionId,
        workspaceRoot,
        hubRoot,
        cancelled: false,
      });
      return { sessionId };
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const session = sessions.get(params.sessionId);
      if (!session) {
        throw new Error(`[trial-agent] Unknown sessionId: ${params.sessionId}`);
      }
      session.cancelled = false;
      const text = extractPromptText(params);
      const handle = createPromptHandler({
        workspaceRoot: session.workspaceRoot,
        hubRoot: session.hubRoot,
      });
      const result = await handle(text);
      if (session.cancelled) {
        return { stopReason: "cancelled" };
      }
      await connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: result.text },
        },
      });
      return { stopReason: "end_turn" };
    },

    async cancel(params: CancelNotification): Promise<void> {
      const session = sessions.get(params.sessionId);
      if (!session) return;
      session.cancelled = true;
    },

    async authenticate() {
      // No external credentials. Every primitive operates on local fs only.
      return {};
    },
  };
}
