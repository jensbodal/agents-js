/**
 * Session notification update handler extracted from ACPSessionController.
 *
 * Processes the discriminated union of `SessionNotification.update` variants
 * and mutates session state accordingly.
 */
import type { SessionNotification, ToolCallContent } from "@agentclientprotocol/sdk";
import type { Logger } from "./logger.ts";
import { callHook } from "./session-hooks.ts";
import {
  createTurnState,
  getValidMessageId,
  mapToolCallContent,
  mapToolCallStatus,
} from "./session-state.ts";
import type { SessionHooks, ToolCallSummary } from "./types/hooks.ts";
import type {
  ACPSessionEvent,
  ACPSessionState,
  PlanEntryInfo,
  ToolCallInfo,
  TurnState,
} from "./types/session.ts";
import type {
  ToolCallContentHandler,
  ToolCallContentHandlerContext,
} from "./types/tool-call-content-handler.ts";

export interface SessionUpdateContentHandlerHooks {
  contentHandlerContext: ToolCallContentHandlerContext;
  toolCallContentHandlers: ToolCallContentHandler[];
}

function partitionHandledToolCallContent(
  content: ToolCallContent[] | null | undefined,
  handlerHooks: SessionUpdateContentHandlerHooks | undefined,
): ToolCallContent[] | null {
  if (content == null) {
    return null;
  }

  const handlers = handlerHooks?.toolCallContentHandlers ?? [];
  if (handlers.length === 0) {
    return content;
  }
  if (!handlerHooks) {
    return content;
  }

  const regular: ToolCallContent[] = [];
  const contentHandlerContext = handlerHooks.contentHandlerContext;
  for (const item of content) {
    let handled = false;
    for (const handler of handlers) {
      try {
        if (handler.consume(item, contentHandlerContext)) {
          handled = true;
          break;
        }
      } catch (error) {
        contentHandlerContext.log.error("ToolCallContentHandler.consume failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!handled) {
      regular.push(item);
    }
  }

  return regular;
}

/**
 * Merge an ACP `ToolCallUpdate`-style three-state field over its
 * prior value. Returns:
 *   - `prior` when the update omitted the field (`undefined`).
 *   - `[]` (empty array) when the harness sent `null` (explicit
 *     clear). Returned as an empty array because the receiver type
 *     `ToolCallInfo.locations` is `T[] | undefined` (not nullable);
 *     "explicit clear" lands as "no locations" rather than "null".
 *   - The new array when the harness sent a replacement.
 *
 * Note: this collapses the SDK's three-state semantic (omitted vs
 * null vs value) to two on `ToolCallInfo` for now. If a downstream
 * consumer needs to distinguish "agent withdrew locations" from
 * "agent never had any", widen `ToolCallInfo.locations` to
 * `T[] | null` and forward `null` through. Receivers like
 * `acp-tool-call-detail` already handle `T[] | null`.
 */
function mergeUpdateField<T>(
  updateValue: T[] | null | undefined,
  prior: T[] | undefined,
): T[] | undefined {
  if (updateValue === undefined) return prior;
  if (updateValue === null) return [];
  return updateValue;
}

/** Terminal ACP tool call statuses that should trigger a tool_call_end emission. */
const TERMINAL_TOOL_CALL_STATUSES = new Set(["completed", "failed"]);

/**
 * Emit a tool_call_start event for the given tool call if it hasn't been emitted yet.
 * Tracks emitted IDs on the turn state to prevent double-emission.
 */
function maybeEmitToolCallStart(
  turn: TurnState,
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string | undefined,
  emit: (event: ACPSessionEvent) => void,
): void {
  if (turn.emittedStartToolCallIds.has(toolCallId)) {
    return;
  }
  turn.emittedStartToolCallIds.add(toolCallId);
  emit({
    type: "tool_call_start",
    toolCallId,
    toolCallName,
    ...(parentMessageId ? { parentMessageId } : {}),
  });
}

/**
 * Emit a tool_call_end event for the given tool call if the status is terminal
 * and an end event hasn't already been emitted.
 */
function maybeEmitToolCallEnd(
  turn: TurnState,
  toolCallId: string,
  status: string | null | undefined,
  emit: (event: ACPSessionEvent) => void,
): void {
  if (!status || !TERMINAL_TOOL_CALL_STATUSES.has(status)) {
    return;
  }
  if (turn.emittedEndToolCallIds.has(toolCallId)) {
    return;
  }
  turn.emittedEndToolCallIds.add(toolCallId);
  emit({ type: "tool_call_end", toolCallId });
}

/**
 * Process a session notification and update state accordingly.
 * Returns nothing -- all mutations happen on the `state` parameter.
 */
export function handleSessionUpdate(
  notification: SessionNotification,
  state: ACPSessionState,
  hooks: SessionHooks | null,
  emit: (event: ACPSessionEvent) => void,
  log: Logger,
  contentHandlerHooks?: SessionUpdateContentHandlerHooks,
): void {
  if (!state.currentTurn) {
    state.currentTurn = createTurnState();
  }
  const turn = state.currentTurn;

  // Process via discriminated union on update.sessionUpdate
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const agentMessageId = getValidMessageId(update.messageId);
      if (!turn.agentMessageId && agentMessageId) {
        turn.agentMessageId = agentMessageId;
      }
      const block = update.content;
      if (block.type === "text") {
        // Only add a new text item if the last item isn't text (preserves interleaving)
        const lastItem = turn.turnItems[turn.turnItems.length - 1];
        if (!lastItem || lastItem.type !== "text") {
          turn.turnItems.push({ type: "text", startIndex: turn.textChunks.length });
        }
        turn.textChunks.push(block.text);
      }
      break;
    }
    case "tool_call": {
      // AG-UI mapping: tool_call with status "pending"/"in_progress" maps to StepStarted;
      // ACP does not provide incremental argument data (ToolCallArgs), so tool_call.args
      // streaming is not emitted here. If a future ACP version adds incremental argument
      // chunks to tool_call notifications, this handler should emit tool_call.args events.
      const tc = update;
      log.info("Tool call notification received", {
        toolCallId: tc.toolCallId,
        title: tc.title,
        kind: tc.kind,
        status: tc.status,
      });
      const regularContent = partitionHandledToolCallContent(tc.content, contentHandlerHooks);
      turn.turnItems.push({ type: "tool_call", id: tc.toolCallId });
      turn.toolCalls.set(tc.toolCallId, {
        id: tc.toolCallId,
        name: tc.title,
        status: mapToolCallStatus(tc.status),
        content: undefined,
        kind: tc.kind ?? undefined,
        richContent: regularContent ? mapToolCallContent(regularContent) : undefined,
        // Forward the SDK's typed `ToolCall` fields directly so
        // downstream consumers (WS bridge → browser UI) get the rich
        // payload that ACP carries. Previously dropped — see the
        // Phase 4 audit at docs/_internal/ws-bridge-session-update-audit.md.
        ...(tc.locations !== undefined ? { locations: tc.locations } : {}),
        ...(tc.rawInput !== undefined ? { rawInput: tc.rawInput } : {}),
        ...(tc.rawOutput !== undefined ? { rawOutput: tc.rawOutput } : {}),
      });

      // AG-UI lifecycle emission: tool_call.start on first observation.
      maybeEmitToolCallStart(turn, tc.toolCallId, tc.title, turn.agentMessageId, emit);
      // AG-UI lifecycle emission: tool_call.end if this first notification
      // already carries a terminal status (some agents skip intermediate updates).
      maybeEmitToolCallEnd(turn, tc.toolCallId, tc.status, emit);

      const tcStatus = tc.status as ToolCallSummary["status"] | undefined;
      if (tcStatus) {
        void callHook(log, "onToolCall", () =>
          hooks?.onToolCall?.(
            { id: tc.toolCallId, name: tc.title, status: tcStatus },
            state.sessionId,
          ),
        );
      }
      break;
    }
    case "tool_call_update": {
      // AG-UI mapping: tool_call_update with terminal status maps to StepFinished;
      // intermediate updates map to ongoing step activity.
      const tc = update;

      const existing = turn.toolCalls.get(tc.toolCallId);
      // If the initial tool_call was missed, synthesize a turnItems entry
      if (!existing) {
        turn.turnItems.push({ type: "tool_call", id: tc.toolCallId });
      }
      const toolName = tc.title ?? existing?.name ?? "unknown";

      // ACP `ToolCallUpdate` distinguishes three states per field:
      //   undefined / omitted → preserve prior
      //   null                → explicit clear
      //   value               → replace
      //
      // For `status`: only call `mapToolCallStatus` when the harness
      // included a status; otherwise preserve `existing.status`.
      // Synthesizing a status when none was sent (the previous
      // behavior, defaulting to "pending") would silently overwrite
      // a prior `running` / `completed` on a payload-only update.
      // Synthesized tool calls (no `existing`) get the SDK default.
      const nextStatus =
        tc.status !== undefined && tc.status !== null
          ? mapToolCallStatus(tc.status)
          : (existing?.status ?? mapToolCallStatus(undefined));

      // For `content`: distinguish undefined (preserve) from null
      // (explicit clear) from array (replace). Apply the
      // content-handler partitioning only on the array case.
      let nextRichContent: ToolCallInfo["richContent"];
      if (tc.content === undefined) {
        nextRichContent = existing?.richContent;
      } else if (tc.content === null) {
        nextRichContent = undefined;
      } else {
        const regular = partitionHandledToolCallContent(tc.content, contentHandlerHooks);
        nextRichContent = regular ? mapToolCallContent(regular) : undefined;
      }

      const nextLocations = mergeUpdateField(tc.locations, existing?.locations);
      // `rawInput` / `rawOutput` use two-state: replace or preserve.
      // ACP doesn't define an "explicit clear" semantic for raw
      // payloads — the spec types them as `unknown`, so null is just
      // a value the harness might legitimately set.
      const nextRawInput = tc.rawInput !== undefined ? tc.rawInput : existing?.rawInput;
      const nextRawOutput = tc.rawOutput !== undefined ? tc.rawOutput : existing?.rawOutput;

      turn.toolCalls.set(tc.toolCallId, {
        id: tc.toolCallId,
        name: toolName,
        status: nextStatus,
        content: existing?.content,
        kind: tc.kind ?? existing?.kind ?? undefined,
        ...(nextRichContent !== undefined ? { richContent: nextRichContent } : {}),
        ...(nextLocations !== undefined ? { locations: nextLocations } : {}),
        ...(nextRawInput !== undefined ? { rawInput: nextRawInput } : {}),
        ...(nextRawOutput !== undefined ? { rawOutput: nextRawOutput } : {}),
      });

      // AG-UI lifecycle emission: tool_call.start if the initial notification
      // was missed and this is the first time we see this tool call.
      maybeEmitToolCallStart(turn, tc.toolCallId, toolName, turn.agentMessageId, emit);
      // AG-UI lifecycle emission: tool_call.end on terminal status transition.
      maybeEmitToolCallEnd(turn, tc.toolCallId, tc.status, emit);

      const tcuStatus = tc.status as ToolCallSummary["status"] | undefined;
      if (tcuStatus) {
        void callHook(log, "onToolCall", () =>
          hooks?.onToolCall?.(
            { id: tc.toolCallId, name: toolName, status: tcuStatus },
            state.sessionId,
          ),
        );
      }
      break;
    }
    case "plan": {
      const entries: PlanEntryInfo[] = update.entries.map((e) => ({
        content: e.content,
        status: e.status,
        priority: e.priority,
      }));
      state.plan = entries;
      emit({ type: "plan_updated", entries });
      break;
    }
    case "current_mode_update": {
      const newModeId = update.currentModeId;
      if (state.modes) {
        state.modes = { ...state.modes, currentModeId: newModeId };
        emit({ type: "mode_changed", modeId: newModeId, modes: state.modes });
      }
      break;
    }
    case "session_info_update": {
      const title = update.title ?? null;
      const updatedAt = update.updatedAt ?? null;
      state.sessionTitle = title;
      state.sessionUpdatedAt = updatedAt;
      emit({ type: "session_info_updated", title, updatedAt });
      break;
    }
    case "available_commands_update": {
      const commands = update.availableCommands;
      state.availableCommands = commands;
      emit({ type: "available_commands_updated", commands });
      log.debug("Available commands updated", { count: commands.length });
      break;
    }
    case "usage_update": {
      const usage = {
        size: update.size,
        used: update.used,
        cost: update.cost ?? null,
      };
      state.usage = usage;
      emit({
        type: "usage_updated",
        size: update.size,
        used: update.used,
        cost: update.cost ?? null,
      });
      log.debug("Usage update received", {
        size: update.size,
        used: update.used,
      });
      break;
    }
  }

  emit({ type: "session_update", notification });
}
