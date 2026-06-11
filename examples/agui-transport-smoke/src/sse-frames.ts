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
import type { BaseEvent } from "@agents-js/agui-types";

/**
 * Read AG-UI SSE frames from a response body, yielding each decoded
 * event as it arrives. Frames may be split across arbitrary chunks;
 * the reader buffers until a blank-line boundary (`\n\n` or `\r\n\r\n`).
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

      while (true) {
        const boundary = nextFrameBoundary(buffer);
        if (boundary === undefined) break;
        const rawFrame = buffer.slice(0, boundary.end);
        buffer = buffer.slice(boundary.end + boundary.skip);
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

interface FrameBoundary {
  end: number;
  skip: number;
}

/** Locate the earliest blank-line frame boundary. Both LFLF and CRLFCRLF are legal SSE. */
function nextFrameBoundary(buffer: string): FrameBoundary | undefined {
  const lflf = buffer.indexOf("\n\n");
  const crlflf = buffer.indexOf("\r\n\r\n");
  if (lflf === -1 && crlflf === -1) return undefined;
  if (lflf !== -1 && (crlflf === -1 || lflf < crlflf)) return { end: lflf, skip: 2 };
  return { end: crlflf, skip: 4 };
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
