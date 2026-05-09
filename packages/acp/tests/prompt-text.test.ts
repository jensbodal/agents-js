import { describe, expect, test } from "bun:test";
import { extractPromptText } from "../src/prompt-text.ts";

describe("extractPromptText", () => {
  test("returns the text for a single text-block prompt", () => {
    expect(
      extractPromptText({
        sessionId: "s",
        prompt: [{ type: "text", text: "Hello world" }],
      }),
    ).toBe("Hello world");
  });

  test("concatenates multi-block prompts without an intervening separator", () => {
    expect(
      extractPromptText({
        sessionId: "s",
        prompt: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      }),
    ).toBe("Hello world");
  });

  test("returns the empty string for an empty prompt array", () => {
    expect(extractPromptText({ sessionId: "s", prompt: [] })).toBe("");
  });

  test("serializes resource_link blocks as <uri> placeholders", () => {
    expect(
      extractPromptText({
        sessionId: "s",
        prompt: [
          { type: "text", text: "See " },
          { type: "resource_link", uri: "file:///tmp/a.txt", name: "a.txt" },
        ],
      }),
    ).toBe("See <file:///tmp/a.txt>");
  });

  test("silently drops unsupported block types (e.g. image)", () => {
    expect(
      extractPromptText({
        sessionId: "s",
        prompt: [
          { type: "text", text: "look:" },
          { type: "image", data: "base64==", mimeType: "image/png" },
        ],
      }),
    ).toBe("look:");
  });

  test("drops resource_link blocks without a uri", () => {
    expect(
      extractPromptText({
        sessionId: "s",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input for the drop path
        prompt: [{ type: "resource_link", name: "no-uri" } as any],
      }),
    ).toBe("");
  });

  test("drops text blocks without a text field", () => {
    expect(
      extractPromptText({
        sessionId: "s",
        // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input for the drop path
        prompt: [{ type: "text" } as any],
      }),
    ).toBe("");
  });
});
