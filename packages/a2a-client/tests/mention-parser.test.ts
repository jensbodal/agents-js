import { describe, expect, test } from "bun:test";
import { parseAgentMentions, stripMention } from "../src/mention-parser.ts";

describe("parseAgentMentions", () => {
  test("extracts @mention at start of string", () => {
    const result = parseAgentMentions("@code-reviewer please look at this");
    expect(result).toEqual([
      { agentName: "code-reviewer", fullMatch: "@code-reviewer", startIndex: 0 },
    ]);
  });

  test("extracts @mention mid-sentence", () => {
    const result = parseAgentMentions("please ask @knowledge-compiler about this");
    expect(result).toEqual([
      { agentName: "knowledge-compiler", fullMatch: "@knowledge-compiler", startIndex: 11 },
    ]);
  });

  test("extracts @mention at end of string", () => {
    const result = parseAgentMentions("forward this to @summarizer");
    expect(result).toEqual([{ agentName: "summarizer", fullMatch: "@summarizer", startIndex: 16 }]);
  });

  test("extracts multiple @mentions", () => {
    const result = parseAgentMentions("@code-reviewer and @knowledge-compiler should collaborate");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      agentName: "code-reviewer",
      fullMatch: "@code-reviewer",
      startIndex: 0,
    });
    expect(result[1]).toEqual({
      agentName: "knowledge-compiler",
      fullMatch: "@knowledge-compiler",
      startIndex: 19,
    });
  });

  test("handles agent names with hyphens", () => {
    const result = parseAgentMentions("ask @my-multi-word-agent for help");
    expect(result).toEqual([
      { agentName: "my-multi-word-agent", fullMatch: "@my-multi-word-agent", startIndex: 4 },
    ]);
  });

  test("handles single-character agent name", () => {
    const result = parseAgentMentions("@x do something");
    expect(result).toEqual([{ agentName: "x", fullMatch: "@x", startIndex: 0 }]);
  });

  test("does NOT match email addresses", () => {
    const result = parseAgentMentions("send to user@example.com please");
    expect(result).toEqual([]);
  });

  test("does NOT match email address even with hyphenated domain", () => {
    const result = parseAgentMentions("contact admin@my-server.org");
    expect(result).toEqual([]);
  });

  test("returns empty array for empty string", () => {
    expect(parseAgentMentions("")).toEqual([]);
  });

  test("returns empty array when no mentions present", () => {
    expect(parseAgentMentions("just a normal sentence with no mentions")).toEqual([]);
  });

  test("handles @mention after newline", () => {
    const result = parseAgentMentions("first line\n@agent2 second line");
    expect(result).toEqual([{ agentName: "agent2", fullMatch: "@agent2", startIndex: 11 }]);
  });

  test("handles @mention after tab", () => {
    const result = parseAgentMentions("item:\t@reviewer check this");
    expect(result).toEqual([{ agentName: "reviewer", fullMatch: "@reviewer", startIndex: 6 }]);
  });

  test("handles @mention followed by punctuation", () => {
    const result = parseAgentMentions("ask @code-reviewer, they know");
    expect(result).toEqual([
      { agentName: "code-reviewer", fullMatch: "@code-reviewer", startIndex: 4 },
    ]);
  });

  test("handles @mention followed by period", () => {
    const result = parseAgentMentions("talk to @summarizer.");
    expect(result).toEqual([{ agentName: "summarizer", fullMatch: "@summarizer", startIndex: 8 }]);
  });

  test("handles @mention followed by colon", () => {
    const result = parseAgentMentions("@reviewer: please check the PR");
    expect(result).toEqual([{ agentName: "reviewer", fullMatch: "@reviewer", startIndex: 0 }]);
  });

  test("does NOT match a bare @ with no name", () => {
    expect(parseAgentMentions("just an @ symbol")).toEqual([]);
  });

  test("does NOT match @mention starting with hyphen", () => {
    expect(parseAgentMentions("@-invalid name")).toEqual([]);
  });

  test("does NOT match @mention ending with hyphen", () => {
    const result = parseAgentMentions("@trailing- oops");
    // Regex matches up to the last valid alphanumeric before the trailing hyphen
    expect(result).toEqual([{ agentName: "trailing", fullMatch: "@trailing", startIndex: 0 }]);
  });

  test("handles numeric agent names", () => {
    const result = parseAgentMentions("@agent42 do something");
    expect(result).toEqual([{ agentName: "agent42", fullMatch: "@agent42", startIndex: 0 }]);
  });

  test("mention preceded by non-whitespace is not matched", () => {
    expect(parseAgentMentions("foo@bar")).toEqual([]);
  });

  test("multiple mentions on separate lines", () => {
    const text = "@agent1 first task\n@agent2 second task\n@agent3 third task";
    const result = parseAgentMentions(text);
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.agentName)).toEqual(["agent1", "agent2", "agent3"]);
  });
});

describe("stripMention", () => {
  test("strips mention at start of string", () => {
    const [mention] = parseAgentMentions("@code-reviewer please look at this");
    if (!mention) throw new Error("expected a parsed mention");
    expect(stripMention("@code-reviewer please look at this", mention)).toBe("please look at this");
  });

  test("strips mention mid-sentence", () => {
    const [mention] = parseAgentMentions("please ask @knowledge-compiler about this");
    if (!mention) throw new Error("expected a parsed mention");
    expect(stripMention("please ask @knowledge-compiler about this", mention)).toBe(
      "please ask about this",
    );
  });

  test("strips mention at end of string", () => {
    const [mention] = parseAgentMentions("forward this to @summarizer");
    if (!mention) throw new Error("expected a parsed mention");
    expect(stripMention("forward this to @summarizer", mention)).toBe("forward this to ");
  });

  test("strips mention that is the entire string", () => {
    const [mention] = parseAgentMentions("@agent");
    if (!mention) throw new Error("expected a parsed mention");
    expect(stripMention("@agent", mention)).toBe("");
  });

  test("strips mention followed by punctuation", () => {
    const [mention] = parseAgentMentions("ask @reviewer, they know");
    if (!mention) throw new Error("expected a parsed mention");
    expect(stripMention("ask @reviewer, they know", mention)).toBe("ask , they know");
  });
});
