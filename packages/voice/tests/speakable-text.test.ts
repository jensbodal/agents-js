import { describe, expect, test } from "bun:test";
import { toSpeakableText } from "../src/index.ts";

describe("toSpeakableText", () => {
  test("passes plain prose through unchanged", () => {
    expect(toSpeakableText("Hello there, how are you today?")).toBe(
      "Hello there, how are you today?",
    );
  });

  test("empty or whitespace-only input yields an empty string", () => {
    expect(toSpeakableText("")).toBe("");
    expect(toSpeakableText("   \n\t  ")).toBe("");
  });

  test("strips bold and italic markers but keeps the words", () => {
    expect(toSpeakableText("This is **bold** and *italic* and __also__ and _too_")).toBe(
      "This is bold and italic and also and too",
    );
  });

  test("strips combined bold-italic markers", () => {
    expect(toSpeakableText("***really important***")).toBe("really important");
  });

  test("keeps inline code text without the backticks", () => {
    expect(toSpeakableText("Run `npm install` to begin")).toBe("Run npm install to begin");
  });

  test("drops fenced code blocks entirely", () => {
    expect(toSpeakableText("Before\n```js\nconst x = 1;\n```\nAfter")).toBe("Before After");
  });

  test("keeps link text and drops the URL", () => {
    expect(toSpeakableText("See [the docs](https://example.com/page) for details")).toBe(
      "See the docs for details",
    );
  });

  test("drops images entirely", () => {
    expect(toSpeakableText("look ![alt text](https://example.com/y.png) here")).toBe("look here");
  });

  test("strips heading markers", () => {
    expect(toSpeakableText("# Title\nbody text")).toBe("Title body text");
    expect(toSpeakableText("### Subsection")).toBe("Subsection");
  });

  test("strips unordered list bullets", () => {
    expect(toSpeakableText("- one\n- two\n- three")).toBe("one two three");
    expect(toSpeakableText("* a\n+ b")).toBe("a b");
  });

  test("strips ordered list numbering", () => {
    expect(toSpeakableText("1. first\n2. second\n3. third")).toBe("first second third");
  });

  test("strips blockquote markers", () => {
    expect(toSpeakableText("> a quoted remark")).toBe("a quoted remark");
  });

  test("removes horizontal rules", () => {
    expect(toSpeakableText("above the line\n---\nbelow the line")).toBe(
      "above the line below the line",
    );
  });

  test("collapses runs of whitespace and newlines to single spaces", () => {
    expect(toSpeakableText("a\n\n\nb    c\t\td")).toBe("a b c d");
  });

  test("normalizes a realistic agent reply into one speakable line", () => {
    const reply = [
      "## Deploy status",
      "",
      "The build **passed**. I ran `bun test` and all suites are green.",
      "",
      "Next steps:",
      "- redeploy the gateway",
      "- watch [the dashboard](https://ajs-gateway.q4m.dev/) for errors",
    ].join("\n");
    expect(toSpeakableText(reply)).toBe(
      "Deploy status The build passed. I ran bun test and all suites are green. " +
        "Next steps: redeploy the gateway watch the dashboard for errors",
    );
  });
});
