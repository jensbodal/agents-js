import { describe, expect, test } from "bun:test";
import { AcpCodeBlock, registerAllComponents } from "../src/index.ts";

describe("AcpCodeBlock", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpCodeBlock).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpCodeBlock.styles).toBeDefined();
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });
});

describe("AcpCodeBlock theming contract", () => {
  const stylesText = (
    Array.isArray(AcpCodeBlock.styles) ? AcpCodeBlock.styles : [AcpCodeBlock.styles]
  )
    .map((s) => String((s as { cssText?: string }).cssText ?? s))
    .join("\n");

  test("declares --acp-code-block-* tokens on :host", () => {
    for (const token of [
      "--acp-code-block-border",
      "--acp-code-block-radius",
      "--acp-code-block-font-size",
      "--acp-code-block-header-bg",
      "--acp-code-block-header-color",
      "--acp-code-block-header-padding",
      "--acp-code-block-font-family",
      "--acp-code-block-bg",
      "--acp-code-block-color",
      "--acp-code-block-padding",
      "--acp-code-block-copy-btn-bg",
      "--acp-code-block-copy-btn-color",
      "--acp-code-block-copy-btn-hover-bg",
      "--acp-code-block-copy-btn-hover-color",
    ]) {
      expect(stylesText).toContain(token);
    }
  });

  test("does NOT leak Obsidian-native CSS variable names", () => {
    // Prior revision referenced --background-modifier-border, --text-muted,
    // --font-monospace, --background-primary, --background-secondary,
    // --interactive-hover, --text-normal, --font-ui-smaller, --font-ui.
    // All should now be replaced by --acp-code-block-* tokens that default
    // into the --acp-* palette.
    for (const obsidianToken of [
      "--background-modifier-border",
      "--background-primary",
      "--background-secondary",
      "--interactive-hover",
      "--text-normal",
      "--font-ui-smaller",
      "--font-monospace",
    ]) {
      expect(stylesText).not.toContain(obsidianToken);
    }
  });

  test("render template exposes the documented parts when header is shown", () => {
    const instance = new (
      AcpCodeBlock as unknown as {
        new (): {
          filename: string;
          language: string;
          code: string;
          render(): unknown;
        };
      }
    )();
    instance.filename = "example.ts";
    instance.language = "ts";
    instance.code = "const x = 1;";
    const flatten = (tpl: unknown): string => {
      const t = tpl as { strings?: readonly string[]; values?: readonly unknown[] };
      let src = (t.strings ?? []).join(" ");
      for (const v of t.values ?? []) {
        if (v && typeof v === "object" && "strings" in (v as object)) {
          src += ` ${flatten(v)}`;
        } else if (typeof v === "string") {
          src += ` ${v}`;
        }
      }
      return src;
    };
    const src = flatten(instance.render());
    expect(src).toContain('part="header"');
    expect(src).toContain('part="filename"');
    expect(src).toContain('part="language"');
    expect(src).toContain('part="copy-btn"');
    expect(src).toContain('part="pre"');
    expect(src).toContain('part="code"');
  });
});
