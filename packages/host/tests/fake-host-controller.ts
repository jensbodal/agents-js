import type { ACPSessionEvent, ACPSessionState } from "@agents-js/acp-host";
import type { RunAgentInput } from "@agents-js/agui-types";
import type { GatewayHostController } from "../src/host-session.ts";

/** The `Pick<>` surface the AG-UI endpoint actually consumes. */
export type ControllerSurface = Pick<
  GatewayHostController,
  "subscribe" | "sendPrompt" | "getState" | "newSession"
>;

export interface FakeHostController {
  controller: ControllerSurface;
  /** Emit an ACPSessionEvent to every subscriber. */
  emit(event: ACPSessionEvent): void;
  /** Count of sendPrompt invocations. */
  sendPromptCalls: () => number;
  /** Replace the handler invoked when a prompt arrives. */
  setOnSendPrompt(handler: (prompt: unknown) => void | Promise<void>): void;
}

/**
 * Test-only fake that implements the narrow `ControllerSurface` used
 * by the AG-UI endpoint handler. Subscribers receive events synchronously
 * via `emit`, and `sendPrompt` dispatches to a caller-supplied handler
 * so individual tests can drive realistic event sequences.
 */
export function createFakeHostController(initial?: Partial<ACPSessionState>): FakeHostController {
  type Listener = (event: ACPSessionEvent, state: ACPSessionState) => void;
  const listeners = new Set<Listener>();
  const state: Partial<ACPSessionState> = {
    sessionId: "session-1",
    status: "ready",
    ...initial,
  };
  let sendPromptCount = 0;
  let onSendPrompt: (prompt: unknown) => void | Promise<void> = () => {};

  const controller: ControllerSurface = {
    subscribe(listener) {
      listeners.add(listener as Listener);
      return () => {
        listeners.delete(listener as Listener);
      };
    },
    async sendPrompt(prompt) {
      sendPromptCount += 1;
      await onSendPrompt(prompt);
    },
    getState() {
      return state as ACPSessionState;
    },
    async newSession() {
      state.sessionId = "session-new";
      return "session-new";
    },
  };

  return {
    controller,
    emit(event) {
      for (const listener of listeners) {
        listener(event, state as ACPSessionState);
      }
    },
    sendPromptCalls: () => sendPromptCount,
    setOnSendPrompt(handler) {
      onSendPrompt = handler;
    },
  };
}

/** Helper to build minimal valid `RunAgentInput` fixtures. */
export function buildRunAgentInput(
  text: string,
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    state: {},
    messages: [{ id: "m-1", role: "user", content: text }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  } as RunAgentInput;
}
