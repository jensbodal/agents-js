import {
  type AguiEventStream,
  createAguiEventStream,
  type RunErrorEvent,
  type RunFinishedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallStartEvent,
} from "@agents-js/agui-types";
import type { JsonRpcMessage } from "./browser-acp-shim.ts";

/**
 * The notification subset of `JsonRpcMessage` — the variant `meta-agent-loop`
 * actually emits via `session/update`. Pulled out as a discriminated alias so
 * the bridge signature is precise (and so consumers get good autocomplete on
 * the `params.kind` field).
 */
export type LoopNotification = Extract<JsonRpcMessage, { method: string }> & {
  method: "session/update";
  params?: unknown;
};

/**
 * Union of the AG-UI event variants this bridge can emit. We intentionally
 * narrow to the subset that maps from `meta-agent-loop` notifications today,
 * not the full AG-UI surface. The underlying `createAguiEventStream` builder
 * returns the broader `BaseEvent` union; the cast at the boundary is sound
 * because each `kind` only triggers builder methods that emit one of these
 * variants. Adding a new variant requires both updating the bridge mapping
 * and adding a regression test.
 */
export type AguiEventEnvelope =
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | RunFinishedEvent
  | RunErrorEvent;

export interface AguiEventBridgeOptions {
  /** Stable run id used in RUN_FINISHED / RUN_ERROR envelopes. */
  runId: string;
  /** Stable thread id used in RUN_FINISHED envelopes. */
  threadId: string;
  /** Injectable id-generator so tests can pin output deterministically. */
  idFactory?: () => string;
}

/**
 * Stateful function that maps a single `LoopNotification` to zero or more
 * canonical AG-UI events.
 *
 * WHY this is a factory (and not a stateless function): AG-UI's
 * `TEXT_MESSAGE_START → ..._CONTENT → ..._END` triple all share a
 * `messageId`, and tool-call events share a `toolCallId`. The source
 * notifications from `meta-agent-loop` carry no such ids — they're a
 * flat stream. The shared `createAguiEventStream` builder owns the
 * open-message + tool-call dedup lifecycle so this bridge stays focused
 * on translating notification shapes.
 *
 * WHY the return is `AguiEventEnvelope[]` (not `| null`): a single source
 * notification (`tool.invoked`) faithfully maps to three AG-UI events
 * (start + args + end). Collapsing to one would lose protocol fidelity.
 *
 * AG-UI v0.0.52 has no first-class "cancelled" run status.
 * `RunFinishedEvent` carries no status field. We map `cancelled` to
 * `RunErrorEvent` with `code: "cancelled"` as the closest semantic.
 */
export function createAguiEventBridge(
  options: AguiEventBridgeOptions,
): (n: LoopNotification) => AguiEventEnvelope[] {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const stream: AguiEventStream = createAguiEventStream({ idFactory });

  return (n: LoopNotification): AguiEventEnvelope[] => {
    const params = (n.params ?? {}) as { kind?: string } & Record<string, unknown>;
    const kind = params.kind;

    switch (kind) {
      case "tool.invoked": {
        const toolCallId = idFactory();
        const toolName = (params.tool as string | undefined) ?? "<unknown-tool>";
        const result = params.result;
        // Stash the result as a JSON-encoded delta. AG-UI args events are
        // strings; the renderer can parse if it cares.
        const argsChunk = JSON.stringify({ tool: toolName, result });
        return [
          ...stream.toolCallStart({ toolName, toolCallId }),
          ...stream.toolCallArgs({ toolCallId, argsChunk }),
          ...stream.toolCallEnd({ toolCallId }),
        ] as AguiEventEnvelope[];
      }

      case "answer.chunk": {
        const text = (params.text as string | undefined) ?? "";
        return stream.textChunk({ text }) as AguiEventEnvelope[];
      }

      case "answer.done": {
        // The builder's `runFinished` auto-closes any open text message
        // before emitting RUN_FINISHED, replacing the manual `if
        // (openMessageId !== null)` branch the hand-rolled bridge used to
        // carry. Behaviour is unchanged for callers.
        return stream.runFinished({
          threadId: options.threadId,
          runId: options.runId,
        }) as AguiEventEnvelope[];
      }

      case "clarify": {
        // AG-UI has no first-class "clarify" event; render as a single-shot
        // assistant text message.
        // If a future spec bump adds a clarify primitive, swap here.
        const messageId = idFactory();
        const prompt = (params.prompt as string | undefined) ?? "";
        return [
          ...stream.textChunk({ text: prompt, messageId }),
          ...stream.textEnd(),
        ] as AguiEventEnvelope[];
      }

      case "error": {
        const message = (params.message as string | undefined) ?? "unknown error";
        // `runError` also flushes any open text message — a small
        // correctness improvement over the prior hand-rolled bridge,
        // which left an open START hanging if `error` arrived mid-stream.
        return stream.runError({ message }) as AguiEventEnvelope[];
      }

      case "cancelled": {
        return stream.runError({
          message: "run cancelled",
          code: "cancelled",
        }) as AguiEventEnvelope[];
      }

      default:
        return [];
    }
  };
}
