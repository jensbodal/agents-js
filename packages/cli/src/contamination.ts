/**
 * Detects stdout contamination from ACP agent processes.
 * Validates that the first stdout line is valid ndJSON with a `jsonrpc` field.
 */

export interface ContaminationResult {
  ok: boolean;
  reason?: "empty" | "binary" | "not_json" | "json_without_jsonrpc";
  firstLine?: string;
}

/**
 * Matches ANSI CSI escape sequences (ESC `[` … final-byte). Regex is the
 * idiomatic way to express this — the alternative is a hand-rolled state
 * machine that scans for ESC and walks the parameter bytes.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the ANSI escape introducer
const ANSI_CSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;

/**
 * Matches C0 control characters that indicate binary content, excluding
 * TAB (0x09), LF (0x0a), and CR (0x0d). A character-class regex is the
 * shortest readable form for "this byte range minus a few exceptions".
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional binary detection
const BINARY_CONTROL_CHARS = /[\x00-\x08\x0e-\x1f]/;

export function inspectFirstChunk(chunk: Buffer | Uint8Array): ContaminationResult {
  if (chunk.length === 0) {
    return { ok: false, reason: "empty", firstLine: "" };
  }

  const raw = Buffer.from(chunk).toString("utf8");
  const stripped = raw.replace(ANSI_CSI_PATTERN, "").trim();
  const firstLine = stripped.split("\n")[0]?.trim() ?? "";

  if (firstLine.length === 0) {
    return { ok: false, reason: "empty", firstLine: "" };
  }

  if (BINARY_CONTROL_CHARS.test(firstLine)) {
    return { ok: false, reason: "binary", firstLine: firstLine.slice(0, 80) };
  }

  try {
    const parsed = JSON.parse(firstLine);
    if (typeof parsed !== "object" || parsed === null || !("jsonrpc" in parsed)) {
      return { ok: false, reason: "json_without_jsonrpc", firstLine };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "not_json", firstLine: firstLine.slice(0, 200) };
  }
}

export function formatContaminationError(result: ContaminationResult): string {
  const reasons: Record<string, string> = {
    empty: "Agent stdout was empty. The agent may have crashed or written to stderr only.",
    binary: "Agent stdout contains binary data. The process may not be an ACP agent.",
    not_json:
      "Agent stdout is not valid JSON. Plugins or shell config may be printing to stdout. Try --profile to isolate.",
    json_without_jsonrpc:
      "Agent stdout is JSON but missing 'jsonrpc' field. Not an ACP ndJSON stream.",
  };
  const msg = reasons[result.reason ?? ""] ?? `Unknown: ${result.reason}`;
  const preview = result.firstLine ? `\n  First line: ${result.firstLine}` : "";
  return `[agents-js] Stdout contamination detected: ${msg}${preview}`;
}
