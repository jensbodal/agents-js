import { describe, expect, test } from "bun:test";
import { AcpMessage } from "../src/acp-message.ts";

describe("AcpMessage", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpMessage).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpMessage.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpMessage.styles)).toBe(true);
  });

  test("has reactive property for messageRole", () => {
    const props = AcpMessage.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("messageRole")).toBeDefined();
  });

  test("messageRole property uses 'role' as HTML attribute name", () => {
    expect(AcpMessage.elementProperties.get("messageRole")?.attribute).toBe("role");
  });

  test("messageRole property has String type", () => {
    expect(AcpMessage.elementProperties.get("messageRole")?.type).toBe(String);
  });

  test("has reactive property for text", () => {
    expect(AcpMessage.elementProperties.get("text")).toBeDefined();
  });

  test("text property has String type", () => {
    expect(AcpMessage.elementProperties.get("text")?.type).toBe(String);
  });

  test("has exactly 3 element properties (messageRole, text, _copied)", () => {
    expect(AcpMessage.elementProperties.size).toBe(3);
  });

  test("has internal _copied state property", () => {
    const prop = AcpMessage.elementProperties.get("_copied");
    expect(prop).toBeDefined();
    expect(prop?.state).toBe(true);
  });

  test("prototype has _handleCopy method", () => {
    expect(typeof (AcpMessage.prototype as Record<string, unknown>)._handleCopy).toBe("function");
  });

  test("prototype has _renderMarkdown method", () => {
    expect(typeof (AcpMessage.prototype as Record<string, unknown>)._renderMarkdown).toBe(
      "function",
    );
  });

  test("prototype has _tokenizeInline method", () => {
    expect(typeof (AcpMessage.prototype as Record<string, unknown>)._tokenizeInline).toBe(
      "function",
    );
  });

  test("prototype has _renderInlineTokens method", () => {
    expect(typeof (AcpMessage.prototype as Record<string, unknown>)._renderInlineTokens).toBe(
      "function",
    );
  });
});

describe("AcpMessage theming contract", () => {
  const stylesText = (Array.isArray(AcpMessage.styles) ? AcpMessage.styles : [AcpMessage.styles])
    .map((s) => String((s as { cssText?: string }).cssText ?? s))
    .join("\n");

  test("declares --acp-message-* tokens on :host", () => {
    expect(stylesText).toContain("--acp-message-padding");
  });

  test("declares --acp-bubble-* tokens on :host", () => {
    for (const token of [
      "--acp-bubble-max-width",
      "--acp-bubble-padding",
      "--acp-bubble-radius",
      "--acp-bubble-radius-tail",
      "--acp-bubble-font-size",
      "--acp-bubble-line-height",
      "--acp-bubble-user-bg",
      "--acp-bubble-user-color",
      "--acp-bubble-agent-bg",
      "--acp-bubble-agent-color",
    ]) {
      expect(stylesText).toContain(token);
    }
  });

  test("declares --acp-role-label-* tokens on :host", () => {
    for (const token of [
      "--acp-role-label-font-size",
      "--acp-role-label-color-user",
      "--acp-role-label-color-agent",
    ]) {
      expect(stylesText).toContain(token);
    }
  });

  test("render template includes part='role-label', part='bubble', and part='copy-btn'", () => {
    const instance = new AcpMessage();
    instance.messageRole = "agent";
    instance.text = "hi";
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
    expect(src).toContain('part="role-label"');
    expect(src).toContain('part="bubble"');
    expect(src).toContain('part="copy-btn"');
    // Role is forwarded via data-role for state-keyed host CSS
    expect(src).toContain("data-role=");
  });
});

type TokenizeFn = (text: string) => Array<Record<string, unknown>>;

describe("AcpMessage._tokenizeInline (pure tokenizer)", () => {
  // Access the private method for testing
  const tokenize = (AcpMessage.prototype as unknown as Record<string, TokenizeFn>)._tokenizeInline;

  test("plain text produces single text token", () => {
    expect(tokenize.call({}, "hello world")).toEqual([{ type: "text", value: "hello world" }]);
  });

  test("**bold** produces bold token", () => {
    expect(tokenize.call({}, "this is **bold** text")).toEqual([
      { type: "text", value: "this is " },
      { type: "bold", value: "bold" },
      { type: "text", value: " text" },
    ]);
  });

  test("*italic* produces italic token", () => {
    expect(tokenize.call({}, "this is *italic* text")).toEqual([
      { type: "text", value: "this is " },
      { type: "italic", value: "italic" },
      { type: "text", value: " text" },
    ]);
  });

  test("`code` produces code token", () => {
    expect(tokenize.call({}, "use `npm install`")).toEqual([
      { type: "text", value: "use " },
      { type: "code", value: "npm install" },
    ]);
  });

  test("[text](url) produces link token", () => {
    expect(tokenize.call({}, "visit [Example](https://example.com)")).toEqual([
      { type: "text", value: "visit " },
      { type: "link", text: "Example", url: "https://example.com" },
    ]);
  });

  test("newline produces br token", () => {
    expect(tokenize.call({}, "line one\nline two")).toEqual([
      { type: "text", value: "line one" },
      { type: "br" },
      { type: "text", value: "line two" },
    ]);
  });

  test("empty string produces empty array", () => {
    expect(tokenize.call({}, "")).toEqual([]);
  });

  test("special HTML chars preserved as-is in text tokens", () => {
    expect(tokenize.call({}, "A & B < C > D")).toEqual([{ type: "text", value: "A & B < C > D" }]);
  });

  test("mixed formatting in one line", () => {
    const tokens = tokenize.call({}, "use `code` and **bold** and *italic*");
    expect(tokens).toHaveLength(6);
    expect(tokens[0]).toEqual({ type: "text", value: "use " });
    expect(tokens[1]).toEqual({ type: "code", value: "code" });
    expect(tokens[2]).toEqual({ type: "text", value: " and " });
    expect(tokens[3]).toEqual({ type: "bold", value: "bold" });
    expect(tokens[4]).toEqual({ type: "text", value: " and " });
    expect(tokens[5]).toEqual({ type: "italic", value: "italic" });
  });
});

type RenderMarkdownFn = (source: string) => {
  values?: readonly unknown[];
  strings?: readonly string[];
};

describe("AcpMessage._renderMarkdown (fenced code blocks, streaming-tolerant)", () => {
  const render = (AcpMessage.prototype as unknown as Record<string, RenderMarkdownFn>)
    ._renderMarkdown;

  const codeBlockLangAndCode = (result: ReturnType<RenderMarkdownFn>) => {
    // Find each nested template that has a `.language=` binding — that's an
    // <acp-code-block>. Return [{lang, code}, ...] in document order.
    const blocks: Array<{ lang: unknown; code: unknown }> = [];
    const walk = (tpl: unknown): void => {
      const t = tpl as { strings?: readonly string[]; values?: readonly unknown[] };
      const strings = t.strings ?? [];
      const values = t.values ?? [];
      const joined = strings.join("\0");
      if (joined.includes(".language=")) {
        // Binding order in the template: language first, then code.
        blocks.push({ lang: values[0], code: values[1] });
      }
      for (const v of values) {
        if (Array.isArray(v)) for (const item of v) walk(item);
        else if (v && typeof v === "object" && "strings" in (v as object)) walk(v);
      }
    };
    walk(result);
    return blocks;
  };

  test("closed fence renders as a single code block", () => {
    const result = render.call(
      AcpMessage.prototype as never,
      "before\n```ts\nconst x = 1;\n```\nafter",
    );
    const blocks = codeBlockLangAndCode(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lang).toBe("ts");
    expect(blocks[0]?.code).toBe("const x = 1;\n");
  });

  test("unclosed fence during streaming renders as code block (not raw backticks)", () => {
    // Mid-stream state: opening fence + content arrived, closing ``` has not.
    // Before the fix this rendered via the inline tokenizer and surfaced raw
    // backtick + slash. After the fix it renders as a code block whose body
    // grows as more deltas arrive.
    const midStream = "My working directory is:\n```\n/workspace/example";
    const result = render.call(AcpMessage.prototype as never, midStream);
    const blocks = codeBlockLangAndCode(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lang).toBe("");
    expect(blocks[0]?.code).toBe("/workspace/example");
  });

  test("unclosed fence with language hint renders as code block with language", () => {
    const midStream = "Here:\n```bash\ncd /tmp\nls -la";
    const result = render.call(AcpMessage.prototype as never, midStream);
    const blocks = codeBlockLangAndCode(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.lang).toBe("bash");
    expect(blocks[0]?.code).toBe("cd /tmp\nls -la");
  });

  test("multiple closed fences render as multiple code blocks", () => {
    const source = "a\n```\nfoo\n```\nb\n```py\nbar\n```\nc";
    const result = render.call(AcpMessage.prototype as never, source);
    const blocks = codeBlockLangAndCode(result);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.lang).toBe("");
    expect(blocks[0]?.code).toBe("foo\n");
    expect(blocks[1]?.lang).toBe("py");
    expect(blocks[1]?.code).toBe("bar\n");
  });

  test("plain text with no fences produces no code blocks", () => {
    const result = render.call(AcpMessage.prototype as never, "hello world — no fences here");
    expect(codeBlockLangAndCode(result)).toHaveLength(0);
  });

  test("closed fence followed by trailing stream content preserves both", () => {
    // Closed fence followed by further text (post-close streaming) should
    // still match the closing ``` preferentially and leave trailing text
    // to the inline tokenizer.
    const source = "intro\n```\npayload\n```\nepilogue text";
    const result = render.call(AcpMessage.prototype as never, source);
    const blocks = codeBlockLangAndCode(result);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.code).toBe("payload\n");
  });
});

describe("AcpMessage XSS prevention", () => {
  const tokenize = (AcpMessage.prototype as unknown as Record<string, TokenizeFn>)._tokenizeInline;

  test("link URL with attribute injection captured verbatim in token", () => {
    const tokens = tokenize.call({}, '[click](" onmouseover="alert(1))');
    const linkToken = tokens.find((t) => t.type === "link");
    expect(linkToken).toBeDefined();
    // The regex [^)]+ stops at the first ), so the captured URL ends before the closing paren
    expect(linkToken?.url).toBe('" onmouseover="alert(1');
  });

  test("javascript: URL captured verbatim (renderer rejects it)", () => {
    const tokens = tokenize.call({}, "[click](javascript:alert(1))");
    const linkToken = tokens.find((t) => t.type === "link");
    // The regex [^)]+ stops at the first ), so nested parens are excluded
    expect(linkToken?.url).toBe("javascript:alert(1");
  });

  test("HTML tags in text are plain text tokens", () => {
    expect(tokenize.call({}, "<script>alert('xss')</script>")).toEqual([
      { type: "text", value: "<script>alert('xss')</script>" },
    ]);
  });

  test("HTML in bold content stays as text", () => {
    const tokens = tokenize.call({}, '**<img onerror="alert(1)">**');
    const boldToken = tokens.find((t) => t.type === "bold");
    expect(boldToken?.value).toContain("<img");
  });

  test("HTML in code content stays as text", () => {
    const tokens = tokenize.call({}, "`<script>alert(1)</script>`");
    const codeToken = tokens.find((t) => t.type === "code");
    expect(codeToken?.value).toContain("<script>");
  });
});
