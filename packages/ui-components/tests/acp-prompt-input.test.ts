import { describe, expect, test } from "bun:test";
import { AcpPromptInput } from "../src/acp-prompt-input.ts";
import { PromptHistoryStore } from "../src/prompt-history-store.ts";

describe("AcpPromptInput", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpPromptInput).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpPromptInput.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpPromptInput.styles)).toBe(true);
  });

  test("has reactive property for disabled", () => {
    const props = AcpPromptInput.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("disabled")).toBeDefined();
  });

  test("disabled property has Boolean type", () => {
    expect(AcpPromptInput.elementProperties.get("disabled")?.type).toBe(Boolean);
  });

  test("has reactive property for history without attribute", () => {
    const props = AcpPromptInput.elementProperties;
    const historyProp = props.get("history");
    expect(historyProp).toBeDefined();
    expect(historyProp?.attribute).toBe(false);
  });

  test("placeholder is a reactive public property", () => {
    expect(AcpPromptInput.elementProperties.get("placeholder")?.type).toBe(String);
    const input = new AcpPromptInput();
    expect(input.placeholder).toBe("Type a message...");
  });

  test("has 5 public properties (disabled + inflight + history + placeholder + helperText)", () => {
    expect(AcpPromptInput.elementProperties.size).toBe(5);
  });

  test("helperText is a reactive public property", () => {
    expect(AcpPromptInput.elementProperties.get("helperText")?.type).toBe(String);
    const input = new AcpPromptInput();
    expect(input.helperText).toBe("");
  });

  test("prototype has render method", () => {
    expect(typeof AcpPromptInput.prototype.render).toBe("function");
  });
});

describe("AcpPromptInput behavior", () => {
  test("send dispatches trimmed text, clears the textarea, and records history", () => {
    const input = new AcpPromptInput() as AcpPromptInput & {
      _getTextarea(): HTMLTextAreaElement | null;
      _send(): void;
    };

    const textarea = {
      value: "  hello world  ",
      style: { height: "" },
      scrollHeight: 42,
    } as unknown as HTMLTextAreaElement;

    input.history = new PromptHistoryStore();
    Object.assign(input, {
      _getTextarea: () => textarea,
    });

    const sent: string[] = [];
    input.addEventListener("acp-send", ((event: CustomEvent<{ text: string }>) => {
      sent.push(event.detail.text);
    }) as EventListener);

    input._send();

    expect(sent).toEqual(["hello world"]);
    expect(textarea.value).toBe("");
    expect(input.history.getEntries()).toEqual(["hello world"]);
    expect(textarea.style.height).toBe("42px");
  });

  test("history navigation updates the textarea and resizes it", () => {
    const input = new AcpPromptInput() as AcpPromptInput & {
      _getTextarea(): HTMLTextAreaElement | null;
      _handleKeydown(event: KeyboardEvent): void;
    };

    const textarea = {
      value: "",
      style: { height: "" },
      scrollHeight: 220,
      selectionStart: 0,
      selectionEnd: 0,
    } as unknown as HTMLTextAreaElement;

    input.history = new PromptHistoryStore();
    input.history.push("first line\nsecond line");
    Object.assign(input, {
      _getTextarea: () => textarea,
    });

    let prevented = false;
    input._handleKeydown({
      key: "ArrowUp",
      preventDefault() {
        prevented = true;
      },
    } as unknown as KeyboardEvent);

    expect(prevented).toBe(true);
    expect(textarea.value).toBe("first line\nsecond line");
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(0);
    expect(textarea.style.height).toBe("160px");
  });
});
