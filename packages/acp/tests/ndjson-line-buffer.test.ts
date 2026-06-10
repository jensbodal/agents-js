import { describe, expect, test } from "bun:test";
import { NDJSONLineBuffer } from "../src/stream-utils.ts";

describe("NDJSONLineBuffer", () => {
  test("emits complete LF-delimited lines and buffers the partial remainder", () => {
    const buf = new NDJSONLineBuffer();
    expect(buf.push('{"a":1}\n{"b":2}\n{"c"')).toEqual(['{"a":1}', '{"b":2}']);
    expect(buf.push(":3}\n")).toEqual(['{"c":3}']);
  });

  test("strips an optional trailing CR (CRLF streams) but splits only on LF", () => {
    const buf = new NDJSONLineBuffer();
    expect(buf.push("one\r\ntwo\r\n")).toEqual(["one", "two"]);
  });

  test("drops empty lines", () => {
    const buf = new NDJSONLineBuffer();
    expect(buf.push("a\n\n\nb\n")).toEqual(["a", "b"]);
  });

  test("does not split on Unicode line separators inside a value", () => {
    const buf = new NDJSONLineBuffer();
    // U+2028 / U+2029 must stay inside the single JSON line.
    expect(buf.push('{"t":"a b c"}\n')).toEqual(['{"t":"a b c"}']);
  });

  test("decodes multi-byte UTF-8 runes split across chunk boundaries", () => {
    const buf = new NDJSONLineBuffer();
    const euro = Buffer.from("€", "utf-8"); // 3 bytes: e2 82 ac
    expect(buf.push(euro.subarray(0, 2))).toEqual([]);
    expect(buf.push(Buffer.concat([euro.subarray(2), Buffer.from("\n")]))).toEqual(["€"]);
  });

  test("drain returns and clears the residual (non-terminated) bytes", () => {
    const buf = new NDJSONLineBuffer();
    expect(buf.push("partial line, no newline")).toEqual([]);
    expect(buf.drain()).toBe("partial line, no newline");
    expect(buf.drain()).toBe("");
  });
});
