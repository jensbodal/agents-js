import { describe, expect, test } from "bun:test";
import { tokenizeShellArgs } from "../src/index.ts";

describe("tokenizeShellArgs", () => {
  test("splits on unquoted whitespace and collapses runs", () => {
    expect(tokenizeShellArgs("a b c")).toEqual(["a", "b", "c"]);
    expect(tokenizeShellArgs("a   b\t c\n d")).toEqual(["a", "b", "c", "d"]);
    expect(tokenizeShellArgs("  leading and trailing  ")).toEqual(["leading", "and", "trailing"]);
  });

  test("empty / whitespace-only input yields no tokens", () => {
    expect(tokenizeShellArgs("")).toEqual([]);
    expect(tokenizeShellArgs("   \t\n ")).toEqual([]);
  });

  test("double quotes keep internal whitespace as one token", () => {
    expect(tokenizeShellArgs('--msg "hello world"')).toEqual(["--msg", "hello world"]);
    expect(tokenizeShellArgs('"a b" "c d"')).toEqual(["a b", "c d"]);
  });

  test("single quotes keep internal whitespace and are fully literal", () => {
    expect(tokenizeShellArgs("'a b'")).toEqual(["a b"]);
    expect(tokenizeShellArgs("'it\\'s'")).toEqual(["it\\s"]); // backslash literal inside single quotes; quote closes at '
  });

  test("adjacent quoted and unquoted segments concatenate into one token", () => {
    expect(tokenizeShellArgs('foo"bar baz"')).toEqual(["foobar baz"]);
    expect(tokenizeShellArgs("pre'mid'post")).toEqual(["premidpost"]);
  });

  test("backslash escapes whitespace and quote characters outside quotes", () => {
    expect(tokenizeShellArgs("path/with\\ space")).toEqual(["path/with space"]);
    expect(tokenizeShellArgs('\\"quoted\\"')).toEqual(['"quoted"']);
  });

  test("double-quote escapes only apply to backslash and double-quote", () => {
    expect(tokenizeShellArgs('"a\\"b"')).toEqual(['a"b']);
    expect(tokenizeShellArgs('"a\\\\b"')).toEqual(["a\\b"]);
    expect(tokenizeShellArgs('"a\\nb"')).toEqual(["a\\nb"]); // \n is preserved literally in double quotes
  });

  test("quoted empty string is an explicit empty token (callers may filter it)", () => {
    expect(tokenizeShellArgs('"" x')).toEqual(["", "x"]);
    expect(tokenizeShellArgs("'' y")).toEqual(["", "y"]);
    expect(tokenizeShellArgs('"" x').filter(Boolean)).toEqual(["x"]);
  });

  test("is lenient: unterminated quotes and trailing escapes never throw", () => {
    expect(tokenizeShellArgs('"unterminated')).toEqual(["unterminated"]);
    expect(tokenizeShellArgs("'unterminated")).toEqual(["unterminated"]);
    expect(tokenizeShellArgs("trailing\\")).toEqual(["trailing"]);
    expect(tokenizeShellArgs('a "b c')).toEqual(["a", "b c"]);
  });

  test("matches the naive split for simple flag strings (back-compat)", () => {
    const simple = "--foo --bar baz qux";
    expect(tokenizeShellArgs(simple)).toEqual(simple.trim().split(/\s+/).filter(Boolean));
  });

  test("security-relevant: a quoted path with a space stays one inspectable token", () => {
    // permission-engine relies on this: the quoted path must remain a single
    // token so the workspace-boundary check still SEES it (rather than being
    // split into fragments or dropped).
    expect(tokenizeShellArgs('rm "/work space/secret.txt"')).toEqual([
      "rm",
      "/work space/secret.txt",
    ]);
  });
});
