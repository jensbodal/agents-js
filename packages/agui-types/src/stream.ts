import type { BaseEvent } from "@ag-ui/core";
import { toAguiCustom } from "./adapters/custom.ts";
import {
  toAguiTextMessageContent,
  toAguiTextMessageEnd,
  toAguiTextMessageStart,
} from "./adapters/message.ts";
import { toAguiRunError, toAguiRunFinished } from "./adapters/run.ts";
import {
  toAguiToolCallArgs,
  toAguiToolCallEnd,
  toAguiToolCallStart,
} from "./adapters/tool-call.ts";

export interface AguiEventStreamOptions {
  /** Override the id factory used for new message ids. Defaults to `crypto.randomUUID`. */
  idFactory?: () => string;
}

/**
 * Stateful builder that owns the open-message + tool-call dedup lifecycle
 * shared by every gateway/runtime that emits AG-UI events. Each method
 * returns the `BaseEvent[]` to forward to the transport; internal state
 * mutates as a side effect.
 */
export interface AguiEventStream {
  textChunk(input: {
    text: string;
    messageId?: string;
    timestamp?: number;
    rawEvent?: unknown;
  }): BaseEvent[];
  textEnd(input?: { timestamp?: number }): BaseEvent[];
  toolCallStart(input: {
    toolName: string;
    toolCallId: string;
    parentMessageId?: string;
    timestamp?: number;
  }): BaseEvent[];
  toolCallArgs(input: { toolCallId: string; argsChunk: string; timestamp?: number }): BaseEvent[];
  toolCallEnd(input: { toolCallId: string; timestamp?: number }): BaseEvent[];
  custom(input: { name: string; value: unknown; timestamp?: number }): BaseEvent[];
  runFinished(input: { threadId: string; runId: string; timestamp?: number }): BaseEvent[];
  runError(input: { message: string; code?: string; timestamp?: number }): BaseEvent[];
}

/**
 * Create a fresh `AguiEventStream` builder. `runFinished` / `runError`
 * close any open text message and clear the dedup sets so the same
 * instance can be reused across runs without leaking ids.
 */
export function createAguiEventStream(options: AguiEventStreamOptions = {}): AguiEventStream {
  const idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  let openMessageId: string | null = null;
  const startedToolCallIds = new Set<string>();
  const endedToolCallIds = new Set<string>();

  return {
    textChunk({ text, messageId, timestamp, rawEvent }) {
      const events: BaseEvent[] = [];

      // Caller-supplied messageId that doesn't match the open one closes the
      // previous message before opening the new one. This keeps the stream
      // valid (END is required between two STARTs).
      if (messageId !== undefined && openMessageId !== null && messageId !== openMessageId) {
        events.push(toAguiTextMessageEnd({ messageId: openMessageId, timestamp }));
        openMessageId = null;
      }

      if (openMessageId === null) {
        openMessageId = messageId ?? idFactory();
        events.push(toAguiTextMessageStart({ messageId: openMessageId, timestamp }));
      }

      // Each `text` is a delta on the wire; the underlying adapter's diff
      // logic is unused here (`previousText` defaults to `""`).
      events.push(
        toAguiTextMessageContent({ messageId: openMessageId, text, timestamp, rawEvent }),
      );

      return events;
    },

    textEnd(input = {}) {
      if (openMessageId === null) return [];
      const event = toAguiTextMessageEnd({ messageId: openMessageId, timestamp: input.timestamp });
      openMessageId = null;
      return [event];
    },

    toolCallStart({ toolName, toolCallId, parentMessageId, timestamp }) {
      if (startedToolCallIds.has(toolCallId)) return [];
      startedToolCallIds.add(toolCallId);
      return [
        toAguiToolCallStart({
          toolCallId,
          toolCallName: toolName,
          parentMessageId,
          timestamp,
        }),
      ];
    },

    toolCallArgs(input) {
      return [toAguiToolCallArgs(input)];
    },

    toolCallEnd({ toolCallId, timestamp }) {
      if (endedToolCallIds.has(toolCallId)) return [];
      endedToolCallIds.add(toolCallId);
      return [toAguiToolCallEnd({ toolCallId, timestamp })];
    },

    custom(input) {
      return [toAguiCustom(input)];
    },

    runFinished(input) {
      const events: BaseEvent[] = [];
      if (openMessageId !== null) {
        events.push(toAguiTextMessageEnd({ messageId: openMessageId, timestamp: input.timestamp }));
      }
      events.push(toAguiRunFinished(input));
      resetRunState();
      return events;
    },

    runError(input) {
      const events: BaseEvent[] = [];
      if (openMessageId !== null) {
        events.push(toAguiTextMessageEnd({ messageId: openMessageId, timestamp: input.timestamp }));
      }
      events.push(toAguiRunError(input));
      resetRunState();
      return events;
    },
  };

  function resetRunState(): void {
    openMessageId = null;
    startedToolCallIds.clear();
    endedToolCallIds.clear();
  }
}
