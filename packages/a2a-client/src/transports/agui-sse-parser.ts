import type { BaseEvent } from "@agents-js/agui-types";
import { validateAguiEvent } from "@agents-js/validation";
import { AGUIStreamError } from "./agui-errors.ts";

/**
 * Cap on the internal line buffer to defend against a misbehaving or
 * malicious server that streams a never-terminated line. AG-UI events
 * are small JSON objects; 1 MiB comfortably accommodates even large
 * `CUSTOM` payloads while bounding memory growth.
 */
const MAX_BUFFER_BYTES = 1 << 20;

/**
 * Parse an AG-UI Server-Sent Events stream into a generator of validated
 * `BaseEvent` instances.
 *
 * Protocol assumptions (per the Wave 4 shared contract):
 * - Wire: `text/event-stream`, each frame `data: <json>\n\n`.
 * - Frames may be split across arbitrary `Uint8Array` chunks.
 * - `data:` can repeat on consecutive lines; per SSE spec they concatenate
 *   with `\n` before JSON parsing.
 * - Comment lines (`:...`) and non-`data:` fields (`event:`, `id:`, `retry:`)
 *   are ignored — AG-UI carries its `type` in the JSON payload.
 * - Every parsed JSON value runs through `validateAguiEvent`; invalid
 *   payloads raise {@link AGUIStreamError} and terminate the generator.
 */
export async function* parseAguiSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<BaseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort);

  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      const { value, done } = await reader.read();
      if (done) {
        // Flush any trailing frame without a terminating blank line.
        buffer += decoder.decode();
        const tail = buffer.trim();
        if (tail.length > 0) {
          const event = parseFrame(tail);
          if (event !== undefined) {
            yield event;
          }
        }
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      if (buffer.length > MAX_BUFFER_BYTES) {
        throw new AGUIStreamError(
          `[a2a-client] AG-UI SSE buffer exceeded ${MAX_BUFFER_BYTES} bytes without a frame boundary`,
        );
      }

      // Split on blank line separators. SSE permits both "\n\n" and "\r\n\r\n".
      while (true) {
        const boundary = findFrameBoundary(buffer);
        if (boundary === -1) {
          break;
        }
        const rawFrame = buffer.slice(0, boundary.end);
        buffer = buffer.slice(boundary.end + boundary.skip);
        const event = parseFrame(rawFrame);
        if (event !== undefined) {
          yield event;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Reader may already be released if the stream errored.
    }
  }
}

interface FrameBoundary {
  end: number;
  skip: number;
}

function findFrameBoundary(buffer: string): FrameBoundary | -1 {
  // Prefer the earliest boundary. CRLFCRLF and LFLF are both legal.
  const lflf = buffer.indexOf("\n\n");
  const crlflf = buffer.indexOf("\r\n\r\n");
  if (lflf === -1 && crlflf === -1) {
    return -1;
  }
  if (lflf !== -1 && (crlflf === -1 || lflf < crlflf)) {
    return { end: lflf, skip: 2 };
  }
  return { end: crlflf, skip: 4 };
}

function parseFrame(rawFrame: string): BaseEvent | undefined {
  const lines = rawFrame.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith(":")) {
      // SSE comment line.
      continue;
    }
    if (line.startsWith("data:")) {
      // Per SSE spec, a single optional space after the colon is stripped.
      const rest = line.slice(5);
      dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
    }
    // Other SSE fields (event:, id:, retry:) are not used by AG-UI.
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  const payload = dataLines.join("\n");
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch (error) {
    throw new AGUIStreamError(
      `[a2a-client] Malformed JSON in AG-UI SSE frame: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }

  const validation = validateAguiEvent(json);
  if (!validation.valid) {
    throw new AGUIStreamError(
      `[a2a-client] Invalid AG-UI event in SSE frame: ${validation.error.message}`,
      validation.error,
    );
  }

  return validation.value;
}
