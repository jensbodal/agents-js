import { describe, expect, test } from "bun:test";
import { formatContaminationError, inspectFirstChunk } from "../src/contamination.ts";

describe("inspectFirstChunk", () => {
  test("valid ndJSON with jsonrpc field returns ok: true", () => {
    const chunk = Buffer.from('{"jsonrpc":"2.0","method":"initialize","id":1}\n');
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("plain text returns ok: false with reason not_json", () => {
    const chunk = Buffer.from("Welcome to the ACP agent!\n");
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_json");
    expect(result.firstLine).toBe("Welcome to the ACP agent!");
  });

  test("empty buffer returns ok: false with reason empty", () => {
    const chunk = Buffer.from("");
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
    expect(result.firstLine).toBe("");
  });

  test("JSON without jsonrpc field returns ok: false with reason json_without_jsonrpc", () => {
    const chunk = Buffer.from('{"method":"initialize","id":1}\n');
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("json_without_jsonrpc");
    expect(result.firstLine).toBe('{"method":"initialize","id":1}');
  });

  test("ANSI escape codes are stripped before check — valid jsonrpc with ANSI returns ok: true", () => {
    const ansiPrefix = "\x1b[32m"; // green color
    const ansiReset = "\x1b[0m";
    const chunk = Buffer.from(
      `${ansiPrefix}{"jsonrpc":"2.0","method":"init","id":1}${ansiReset}\n`,
    );
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(true);
  });

  test("binary content returns ok: false with reason binary", () => {
    const chunk = Buffer.from([0x7b, 0x00, 0x01, 0x02, 0xff]);
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("binary");
  });

  test("multi-line checks first line only — valid jsonrpc on first line returns ok: true", () => {
    const chunk = Buffer.from('{"jsonrpc":"2.0","method":"init","id":1}\nsome garbage on line 2\n');
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(true);
  });

  test("multi-line with invalid first line returns ok: false", () => {
    const chunk = Buffer.from('loading plugins...\n{"jsonrpc":"2.0","method":"init","id":1}\n');
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_json");
    expect(result.firstLine).toBe("loading plugins...");
  });

  test("whitespace-only buffer returns ok: false with reason empty", () => {
    const chunk = Buffer.from("   \n  \n");
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("empty");
  });

  test("JSON array returns ok: false with reason json_without_jsonrpc", () => {
    const chunk = Buffer.from("[1, 2, 3]\n");
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("json_without_jsonrpc");
  });

  test("JSON null returns ok: false with reason json_without_jsonrpc", () => {
    const chunk = Buffer.from("null\n");
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("json_without_jsonrpc");
  });

  test("truncates long not_json first lines to 200 chars", () => {
    const longLine = "x".repeat(500);
    const chunk = Buffer.from(`${longLine}\n`);
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_json");
    expect(result.firstLine?.length).toBe(200);
  });

  test("truncates long binary first lines to 80 chars", () => {
    const binaryContent = Buffer.alloc(200, 0x01);
    const result = inspectFirstChunk(binaryContent);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("binary");
    expect(result.firstLine?.length).toBeLessThanOrEqual(80);
  });

  test("accepts Uint8Array input", () => {
    const chunk = new Uint8Array(Buffer.from('{"jsonrpc":"2.0","id":1}\n'));
    const result = inspectFirstChunk(chunk);
    expect(result.ok).toBe(true);
  });
});

describe("formatContaminationError", () => {
  test("produces readable output for empty reason", () => {
    const msg = formatContaminationError({ ok: false, reason: "empty", firstLine: "" });
    expect(msg).toContain("[agents-js] Stdout contamination detected");
    expect(msg).toContain("Agent stdout was empty");
  });

  test("produces readable output for not_json reason", () => {
    const msg = formatContaminationError({
      ok: false,
      reason: "not_json",
      firstLine: "Hello world",
    });
    expect(msg).toContain("not valid JSON");
    expect(msg).toContain("--profile");
    expect(msg).toContain("First line: Hello world");
  });

  test("produces readable output for binary reason", () => {
    const msg = formatContaminationError({
      ok: false,
      reason: "binary",
      firstLine: "...",
    });
    expect(msg).toContain("binary data");
  });

  test("produces readable output for json_without_jsonrpc reason", () => {
    const msg = formatContaminationError({
      ok: false,
      reason: "json_without_jsonrpc",
      firstLine: '{"foo":"bar"}',
    });
    expect(msg).toContain("missing 'jsonrpc' field");
    expect(msg).toContain('First line: {"foo":"bar"}');
  });

  test("handles unknown reason gracefully", () => {
    const msg = formatContaminationError({
      ok: false,
      reason: undefined,
      firstLine: "",
    });
    expect(msg).toContain("Unknown");
  });

  test("omits first line preview when firstLine is empty string", () => {
    const msg = formatContaminationError({ ok: false, reason: "empty", firstLine: "" });
    expect(msg).not.toContain("First line:");
  });

  test("includes first line preview when firstLine is non-empty", () => {
    const msg = formatContaminationError({
      ok: false,
      reason: "not_json",
      firstLine: "debug output",
    });
    expect(msg).toContain("First line: debug output");
  });
});
