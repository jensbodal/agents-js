/**
 * Pure ACP → AG-UI event translator.
 *
 * Given an `ACPSessionEvent` (emitted by `ACPSessionController`) and a
 * `TranslatorState` (which now wraps a stateful `AguiEventStream`),
 * returns the sequence of AG-UI `BaseEvent`s that should be forwarded
 * to a single run. State is passed in explicitly so callers control the
 * lifetime of a run.
 *
 * See the tests in `tests/acp-to-agui-translator.test.ts` for
 * exhaustive row-by-row coverage of the current mapping.
 *
 * Lifecycle wrappers (`RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`) are
 * emitted by the endpoint (`agui-endpoint.ts`), NOT by this function —
 * the translator focuses on per-event mapping within an open run.
 */

import { A2UI_SURFACE_EVENT_NAME } from "@agents-js/a2ui-types";
import { type ACPSessionEvent, AcpStreamingTranslator } from "@agents-js/acp-host";
import type { AguiEventStream, BaseEvent } from "@agents-js/agui-types";
import { createAguiEventStream } from "@agents-js/agui-types";

/**
 * Mutable state carried across translator invocations for a single run.
 *
 * The translator delegates open-message tracking and tool-call dedup to
 * the shared `createAguiEventStream` builder so this surface stays
 * minimal. The `stream` instance owns the `currentMessageId`,
 * `emittedToolCallStartIds`, and `emittedToolCallEndIds` lifecycle
 * internally — no need to mirror those sets here.
 */
export interface TranslatorState {
  /** Stateful AG-UI event-stream builder shared across translator calls. */
  stream: AguiEventStream;
  /**
   * Shared streaming-event translator. Owns the canonical ACP
   * `SessionNotification` → typed sink-call mapping for streaming
   * variants (`agent_message_chunk`, `agent_thought_chunk`). The AG-UI
   * translator delegates to it and maps each sink call to a
   * `state.stream.textChunk(...)` emission.
   *
   * Same translator class is used by `@agents-js/a2a`'s executor —
   * single source of truth for ACP streaming semantics.
   */
  acpTranslator: AcpStreamingTranslator;
}

export function createTranslatorState(): TranslatorState {
  return {
    stream: createAguiEventStream(),
    acpTranslator: new AcpStreamingTranslator(),
  };
}

/**
 * Names of ACP session events that should be forwarded as namespaced
 * `CUSTOM` events. Keeping this as an explicit allowlist (rather than a
 * "forward everything unknown" fallback) avoids accidentally leaking
 * internal state transitions.
 */
const CUSTOM_FORWARDED_EVENTS = new Set<ACPSessionEvent["type"]>([
  "plan_updated",
  "mode_changed",
  "model_changed",
  "usage_updated",
  "permission_requested",
  "permission_resolved",
  "elicitation_requested",
  "elicitation_resolved",
  "write_gate_requested",
  "write_gate_resolved",
  "writable_folder_added",
  "ungated_write_detected",
  "permission_gating_status",
  "config_option_changed",
  "logged_out",
  "available_commands_updated",
]);

/**
 * Translate a single `ACPSessionEvent` into zero or more AG-UI events.
 * Mutates only the caller-owned `state` (specifically, the embedded
 * `AguiEventStream`'s open-message + dedup tracking).
 */
export function translateAcpEvent(event: ACPSessionEvent, state: TranslatorState): BaseEvent[] {
  switch (event.type) {
    case "surface_event": {
      return state.stream.custom({
        name: A2UI_SURFACE_EVENT_NAME,
        value: { surfaceId: event.surfaceId, event: event.event },
      });
    }
    case "session_update": {
      const update = event.notification.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        const observedMessageId =
          typeof (update as { messageId?: unknown }).messageId === "string" &&
          (update as { messageId: string }).messageId.length > 0
            ? (update as { messageId: string }).messageId
            : undefined;
        // ACP `agent_message_chunk.content.text` carries the *delta*, not
        // accumulated text — the builder's `toAguiTextMessageContent`
        // defaults `previousText=""`, so the value passes through verbatim.
        //
        // When `messageId` is present we route through the shared
        // `AcpStreamingTranslator` so the per-message accumulation contract
        // is enforced in one place (same translator the A2A executor uses).
        // When it's absent we fall through to a direct `textChunk(...)`
        // emission so the `AguiEventStream` builder can synthesize its own
        // messageId — the translator deliberately drops unidentifiable
        // chunks rather than fabricating an id.
        if (observedMessageId !== undefined) {
          const out: BaseEvent[] = [];
          state.acpTranslator.feed(event.notification, {
            onTextDelta: ({ messageId, delta }) => {
              out.push(...state.stream.textChunk({ text: delta, messageId }));
            },
            // Thought / tool-call / plan / commands / mode / usage
            // notifications still flow through their own ACPSessionEvent
            // paths in this translator (they don't arrive as
            // `agent_message_chunk`); these stubs are unreachable for
            // `agent_message_chunk` input but keep the sink contract
            // satisfied without `as any` casts.
            onThoughtDelta: () => {},
            onToolCallStart: () => {},
            onToolCallUpdate: () => {},
            onPlanUpdate: () => {},
            onAvailableCommandsUpdate: () => {},
            onModeChange: () => {},
            onUsageUpdate: () => {},
            onSessionInfoUpdate: () => {},
          });
          return out;
        }
        return state.stream.textChunk({
          text: update.content.text ?? "",
          messageId: undefined,
        });
      }
      // Other session_update sub-variants (plan/mode/info/commands) are
      // re-emitted by the controller as top-level events — see the
      // translation table. Drop here to avoid double-forwarding.
      return [];
    }

    case "tool_call_start": {
      return state.stream.toolCallStart({
        toolName: event.toolCallName,
        toolCallId: event.toolCallId,
        ...(event.parentMessageId ? { parentMessageId: event.parentMessageId } : {}),
      });
    }

    case "tool_call_end": {
      return state.stream.toolCallEnd({ toolCallId: event.toolCallId });
    }

    case "turn_completed": {
      // Close any open text message, then surface the stop reason as a
      // CUSTOM event. RUN_FINISHED is emitted by the endpoint, not here.
      const out: BaseEvent[] = [];
      out.push(...state.stream.textEnd());
      out.push(
        ...state.stream.custom({
          name: "agents-js.stop_reason",
          value: event.stopReason,
        }),
      );
      return out;
    }

    case "error": {
      // The endpoint wraps this as RUN_ERROR. The translator does not
      // emit RUN_ERROR itself — returning an empty array keeps the
      // translator focused on per-event mapping and lets the endpoint
      // own the lifecycle.
      return [];
    }

    default: {
      if (CUSTOM_FORWARDED_EVENTS.has(event.type as ACPSessionEvent["type"])) {
        // Strip the discriminator before forwarding — AG-UI CUSTOM
        // already carries the name, and duplicating it in `value`
        // would just be noise.
        const { type: _type, ...rest } = event as ACPSessionEvent & {
          type: string;
        };
        return state.stream.custom({
          name: `agents-js.${event.type}`,
          value: rest,
        });
      }
      // status_changed, session_created/loaded/closed/forked/resumed,
      // queue_changed, session_info_updated — internal or superseded.
      return [];
    }
  }
}
