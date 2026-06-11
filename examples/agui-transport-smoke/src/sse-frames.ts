/**
 * Minimal AG-UI Server-Sent Events frame reader.
 *
 * The native AG-UI endpoint writes one `data: <json>\n\n` frame per
 * event (see `packages/a2a-client/src/transports/agui-sse-parser.ts`
 * for the production parser this mirrors). This in-package reader keeps
 * the smoke self-contained: it parses raw `Accept: text/event-stream`
 * response bodies into typed AG-UI events without pulling in the full
 * client transport, so the smoke exercises the wire format directly.
 *
 * Scope: it understands `data:` lines and blank-line frame boundaries.
 * It does not validate against the AG-UI schema — callers assert on the
 * `type` field of the decoded JSON.
 */
import { splitAguiSseFrames } from "@agents-js/a2a-client";
import type { BaseEvent } from "@agents-js/agui-types";

/**
 * Read AG-UI SSE frames from a response body, yielding each decoded
 * event as it arrives. Frame-boundary detection is delegated to the
 * production splitter ({@link splitAguiSseFrames}) so there is a single
 * wire-format implementation; this reader keeps only the validation-free
 * event shaping, decoding each frame's `data:` lines straight to JSON
 * without the client's AG-UI schema check.
 */
export async function* readAguiSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<BaseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = buffer.trim();
        if (tail.length > 0) {
          const event = decodeFrame(tail);
          if (event !== undefined) yield event;
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      const { frames, rest } = splitAguiSseFrames(buffer);
      buffer = rest;
      for (const rawFrame of frames) {
        const event = decodeFrame(rawFrame);
        if (event !== undefined) yield event;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released if the stream errored — ignore so
      // a teardown error never masks the real assertion failure.
    }
  }
}

/** Decode a single SSE frame into an AG-UI event, or undefined if it carries no `data:`. */
function decodeFrame(rawFrame: string): BaseEvent | undefined {
  const dataLines: string[] = [];
  for (const line of rawFrame.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      // Per SSE spec, a single optional space after the colon is stripped.
      const rest = line.slice(5);
      dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
    }
  }
  if (dataLines.length === 0) return undefined;
  return JSON.parse(dataLines.join("\n")) as BaseEvent;
}
