import { describe, expect, test } from "bun:test";
import { AcpStreamingText } from "../src/acp-streaming-text.ts";

describe("AcpStreamingText", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpStreamingText).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpStreamingText.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpStreamingText.styles)).toBe(true);
  });

  test("has reactive property for text", () => {
    const props = AcpStreamingText.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("text")).toBeDefined();
  });

  test("text property has String type", () => {
    expect(AcpStreamingText.elementProperties.get("text")?.type).toBe(String);
  });

  test("has exactly 1 element property", () => {
    expect(AcpStreamingText.elementProperties.size).toBe(1);
  });

  test("extends LitElement (has prototype chain)", () => {
    expect(AcpStreamingText.prototype).toBeDefined();
    expect(typeof AcpStreamingText.prototype.render).toBe("function");
  });
});

describe("AcpStreamingText theming contract", () => {
  const stylesText = (
    Array.isArray(AcpStreamingText.styles) ? AcpStreamingText.styles : [AcpStreamingText.styles]
  )
    .map((s) => String((s as { cssText?: string }).cssText ?? s))
    .join("\n");

  test("declares --acp-streaming-* tokens on :host", () => {
    for (const token of [
      "--acp-streaming-padding",
      "--acp-streaming-color",
      "--acp-streaming-font-size",
      "--acp-streaming-line-height",
      "--acp-streaming-cursor-bg",
      "--acp-streaming-cursor-width",
    ]) {
      expect(stylesText).toContain(token);
    }
  });

  test("render template exposes part='text' and part='cursor'", () => {
    const instance = new AcpStreamingText();
    instance.text = "streaming...";
    const template = instance.render() as unknown as { strings: readonly string[] };
    const src = template.strings.join("");
    expect(src).toContain('part="text"');
    expect(src).toContain('part="cursor"');
  });
});
