import { describe, expect, test } from "bun:test";
import { parseSkillYaml, YamlParseError } from "../src/index.ts";

describe("parseSkillYaml", () => {
  test("parses simple key-scalar pairs", () => {
    const out = parseSkillYaml("name: valid-skill\ndescription: hello world");
    expect(out).toEqual({ name: "valid-skill", description: "hello world" });
  });

  test("parses inline flow arrays", () => {
    const out = parseSkillYaml("aliases: [alpha, beta, gamma]");
    expect(out).toEqual({ aliases: ["alpha", "beta", "gamma"] });
  });

  test("parses block-style arrays", () => {
    const out = parseSkillYaml("allowed-tools:\n  - Read\n  - Write\n  - Bash");
    expect(out).toEqual({ "allowed-tools": ["Read", "Write", "Bash"] });
  });

  test("handles double-quoted strings with escapes", () => {
    const out = parseSkillYaml('description: "line one\\nline two"');
    expect(out).toEqual({ description: "line one\nline two" });
  });

  test("handles single-quoted strings with '' escape", () => {
    const out = parseSkillYaml("note: 'isn''t it'");
    expect(out).toEqual({ note: "isn't it" });
  });

  test("strips trailing comments", () => {
    const out = parseSkillYaml("name: valid # with a comment");
    expect(out).toEqual({ name: "valid" });
  });

  test("throws on unexpected indented top-level line", () => {
    expect(() => parseSkillYaml("name: valid\n  stray: line")).toThrow(YamlParseError);
  });

  test("throws on a line that is not key: value", () => {
    expect(() => parseSkillYaml("not a key")).toThrow(YamlParseError);
  });

  test("treats a bare key with no value and no block as null", () => {
    const out = parseSkillYaml("empty:");
    expect(out).toEqual({ empty: null });
  });

  test("parses integer and float scalars", () => {
    const out = parseSkillYaml("count: 7\nratio: 0.25");
    expect(out).toEqual({ count: 7, ratio: 0.25 });
  });

  test("parses booleans and null", () => {
    const out = parseSkillYaml("a: true\nb: false\nc: null\nd: ~");
    expect(out).toEqual({ a: true, b: false, c: null, d: null });
  });
});
