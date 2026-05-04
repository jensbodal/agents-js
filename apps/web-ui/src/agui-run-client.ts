/**
 * Browser AG-UI run client for the reference web UI.
 *
 * AG-UI is the **primary run path** for restricted-beta. The web UI's
 * existing A2AClientController stays in place as a connection-state
 * holder (target URL resolution, agent-card discovery, listener
 * subscriptions) but the actual prompt → completion stream is driven
 * by `POST /agent` SSE rather than A2A JSON-RPC. The host bridge WS
 * still receives all ACP events from the gateway's primary controller,
 * so the chat UI continues to render normally.
 *
 * Compatibility: append `?run=a2a` to the page URL to keep the legacy
 * A2A `sendTurn` path. This is a diagnostic escape hatch — the
 * default for new operators is AG-UI.
 */
import { randomUuid } from "@agents-js/a2a-client";
import { type BaseEvent, EventType, type RunAgentInput } from "@agents-js/agui-types";

/** The minimum surface this module needs from the controller. */
interface ControllerSurface {
  getState(): { targetInput?: { url?: string } | null } | undefined;
  sendTurn(text: string): Promise<unknown>;
}

/** Options for {@link runTurnViaAgUi}. */
export interface RunTurnViaAgUiOptions {
  /** Base URL of the gateway. `/agent` is appended. */
  baseUrl: string;
  /** Prompt text to send. */
  text: string;
  /** Stable thread id. Reuse across turns within a session. */
  threadId: string;
  /** Optional logger; defaults to `console`. */
  logger?: Pick<Console, "warn" | "error" | "log">;
  /** Optional abort signal for client-side cancellation. */
  signal?: AbortSignal;
}

/** Thrown when the gateway is busy (HTTP 409). Surfaces a friendly message. */
export class AguiRunBusyError extends Error {
  readonly activeRunId: string;
  constructor(activeRunId: string) {
    super(
      `The gateway is already running another AG-UI turn (active runId=${activeRunId}). ` +
        "Wait for the current run to finish or cancel it from the chat UI before sending again.",
    );
    this.name = "AguiRunBusyError";
    this.activeRunId = activeRunId;
  }
}

/**
 * POST `${baseUrl}/agent` with a minimal RunAgentInput, consume the
 * SSE stream, and resolve when RUN_FINISHED arrives. The gateway's
 * primary controller fans ACP events back through the WS bridge, so
 * this client deliberately does NOT translate AG-UI events into chat
 * UI updates — that is the bridge's job.
 *
 * On 409 (Busy), throws {@link AguiRunBusyError} so the chat UI can
 * surface a clear notice. On RUN_ERROR, throws an Error with the
 * server-supplied message. On unexpected stream termination, throws
 * a generic Error.
 */
export async function runTurnViaAgUi(options: RunTurnViaAgUiOptions): Promise<void> {
  const { baseUrl, text, threadId, signal } = options;
  const logger = options.logger ?? console;
  const url = new URL("/agent", baseUrl).toString();

  const input: RunAgentInput = {
    threadId,
    runId: randomUuid(),
    state: {},
    messages: [{ id: randomUuid(), role: "user", content: text }],
    tools: [],
    context: [],
    forwardedProps: {},
  } as RunAgentInput;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(input),
    signal,
  });

  if (response.status === 409) {
    const body = (await response.json()) as { activeRunId?: string; message?: string };
    throw new AguiRunBusyError(body.activeRunId ?? "(unknown)");
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`AG-UI POST /agent failed: HTTP ${response.status} ${body}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("AG-UI response had no readable body");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let terminated = false;
  let errorMessage: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line ("\n\n").
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) continue;
        let event: BaseEvent;
        try {
          event = JSON.parse(dataLine.slice("data: ".length)) as BaseEvent;
        } catch (err) {
          logger.warn("[web-ui/AG-UI] Skipping invalid SSE frame", {
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (event.type === EventType.RUN_ERROR) {
          errorMessage =
            (event as { type: typeof EventType.RUN_ERROR; message?: string }).message ??
            "AG-UI run failed";
          terminated = true;
        } else if (event.type === EventType.RUN_FINISHED) {
          terminated = true;
        }
      }
      if (terminated) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader may already be closed; ignore.
    }
  }

  if (errorMessage !== null) {
    throw new Error(errorMessage);
  }
}

/**
 * Wrap a controller so its `sendTurn` routes through AG-UI's
 * `POST /agent` instead of A2A JSON-RPC. The original `sendTurn` is
 * kept available on the returned object as `legacyA2ASendTurn` for
 * diagnostic purposes.
 *
 * The thread id is generated once per page load and reused across
 * turns so the gateway sees a stable AG-UI thread.
 */
export function wrapControllerForAgUiRuns<T extends ControllerSurface>(
  controller: T,
  options: { fallbackBaseUrl: string; logger?: Pick<Console, "warn" | "error" | "log"> } = {
    fallbackBaseUrl: "",
  },
): T & { legacyA2ASendTurn: T["sendTurn"] } {
  const fallbackBaseUrl = options.fallbackBaseUrl;
  const logger = options.logger ?? console;
  const threadId = randomUuid();
  const original = controller.sendTurn.bind(controller);

  // We mutate the same instance so existing references (chatApp.controller,
  // listeners, etc.) keep pointing at the now-AG-UI-driven object.
  (controller as ControllerSurface).sendTurn = async (text: string) => {
    const baseUrl = controller.getState()?.targetInput?.url ?? fallbackBaseUrl;
    if (!baseUrl) {
      logger.warn("[web-ui/AG-UI] No target URL resolved; falling back to A2A sendTurn");
      return original(text);
    }
    await runTurnViaAgUi({ baseUrl, text, threadId, logger });
    return undefined;
  };

  const wrapped = controller as T & { legacyA2ASendTurn: T["sendTurn"] };
  wrapped.legacyA2ASendTurn = original;
  return wrapped;
}
