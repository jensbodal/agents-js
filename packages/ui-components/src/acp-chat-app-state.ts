/**
 * Pure derivation of component state from a SessionStateLike snapshot.
 *
 * Extracted from AcpChatApp._applyState to enable unit testing of the
 * derivation logic (especially `inputDisabled` and `connected`) without
 * instantiating a Lit element.
 */

import type {
  AgentCardLike,
  PermissionRequestLike,
  PlanEntryLike,
  SessionStateLike,
  WriteGateLike,
} from "./acp-types.ts";

export interface ChatAppDerivedState {
  status: string;
  sessionId: string;
  transcript: Array<{ id: string; role: string; text: string }>;
  pendingText: string;
  activeElicitation: SessionStateLike["activeElicitation"] | null;
  activeAuth: SessionStateLike["activeAuth"] | null;
  inputDisabled: boolean;
  pendingPermission: PermissionRequestLike | null;
  pendingWriteGate: WriteGateLike | null;
  permissionMode: string;
  sessionState: SessionStateLike;
  connected: boolean;
  agentCard: AgentCardLike | null;
  agentName: string;
  sessionTitle: string;
  plan: PlanEntryLike[];
  lastError: string;
}

/**
 * SessionViewState groups the derived state fields that drive
 * the main chat view rendering.  The component stores this as
 * a single `@state()` property with a custom `hasChanged` guard
 * instead of 17+ individual reactive properties.
 */
export type SessionViewState = ChatAppDerivedState;

/**
 * Derive flat component properties from an incoming SessionStateLike.
 *
 * This is a pure function with no side effects — the caller is responsible
 * for applying the result to Lit reactive properties with change guards.
 */
export function deriveSessionState(state: SessionStateLike): ChatAppDerivedState {
  const status = state.status ?? "idle";
  const sessionId = state.sessionId ?? "";
  const transcript = (state.transcript ?? []) as Array<{
    id: string;
    role: string;
    text: string;
  }>;
  const pendingText = state.pendingAgentText ?? "";
  const activeElicitation = state.activeElicitation ?? null;
  const activeAuth = state.activeAuth ?? null;

  const inputDisabled =
    state.status !== "connected" && !(state.status === "error" && !!state.target);

  const pendingPermission = state.pendingPermission ?? null;
  const pendingWriteGate = state.pendingWriteGate ?? null;
  const permissionMode = state.permissionMode ?? "ask";

  const isConnected =
    state.status !== "idle" && state.status !== "connecting" && state.status !== "error";
  const connected = isConnected && !!state.target;

  const agentCard = state.target?.card ?? null;
  const agentName = agentCard?.name ?? "";

  const sessionTitle = ((state as Record<string, unknown>).sessionTitle as string) ?? "";
  const plan = ((state as Record<string, unknown>).plan as PlanEntryLike[] | undefined) ?? [];
  const lastError = state.lastError ?? "";

  return {
    status,
    sessionId,
    transcript,
    pendingText,
    activeElicitation,
    activeAuth,
    inputDisabled,
    pendingPermission,
    pendingWriteGate,
    permissionMode,
    sessionState: state,
    connected,
    agentCard,
    agentName,
    sessionTitle,
    plan,
    lastError,
  };
}

/**
 * Shallow-compare two `SessionViewState` objects.
 *
 * Returns `true` when at least one top-level value differs
 * (meaning the component should re-render).
 */
export function sessionViewStateChanged(
  prev: SessionViewState | undefined,
  next: SessionViewState | undefined,
): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;
  for (const key of Object.keys(next) as Array<keyof SessionViewState>) {
    if (prev[key] !== next[key]) return true;
  }
  return false;
}
