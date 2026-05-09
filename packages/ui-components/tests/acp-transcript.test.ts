import { describe, expect, test } from "bun:test";
import { AcpTranscript } from "../src/acp-transcript.ts";

describe("AcpTranscript", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpTranscript).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpTranscript.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpTranscript.styles)).toBe(true);
  });

  test("has reactive property for transcript", () => {
    const props = AcpTranscript.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("transcript")).toBeDefined();
  });

  test("transcript property does not reflect to attribute", () => {
    expect(AcpTranscript.elementProperties.get("transcript")?.attribute).toBe(false);
  });

  test("has reactive property for pendingText", () => {
    expect(AcpTranscript.elementProperties.get("pendingText")).toBeDefined();
  });

  test("pendingText property has String type", () => {
    expect(AcpTranscript.elementProperties.get("pendingText")?.type).toBe(String);
  });

  test("has exactly 6 element properties (4 public + 2 state)", () => {
    expect(AcpTranscript.elementProperties.size).toBe(6);
  });

  test("has internal state property _userScrolledUp", () => {
    expect(AcpTranscript.elementProperties.get("_userScrolledUp")?.state).toBe(true);
  });

  test("has reactive property for status", () => {
    expect(AcpTranscript.elementProperties.get("status")).toBeDefined();
  });

  test("status property has String type", () => {
    expect(AcpTranscript.elementProperties.get("status")?.type).toBe(String);
  });

  test("prototype has render method", () => {
    expect(typeof AcpTranscript.prototype.render).toBe("function");
  });

  test("_showThinking returns true when status is sending and no pendingText", () => {
    const instance = new AcpTranscript();
    instance.status = "sending";
    instance.pendingText = "";
    // Access the private getter via bracket notation
    expect((instance as unknown as { _showThinking: boolean })._showThinking).toBe(true);
  });

  test("_showThinking returns true when status is waiting and no pendingText", () => {
    const instance = new AcpTranscript();
    instance.status = "waiting";
    instance.pendingText = "";
    expect((instance as unknown as { _showThinking: boolean })._showThinking).toBe(true);
  });

  test("_showThinking returns false when pendingText exists", () => {
    const instance = new AcpTranscript();
    instance.status = "sending";
    instance.pendingText = "streaming content...";
    expect((instance as unknown as { _showThinking: boolean })._showThinking).toBe(false);
  });

  test("_showThinking returns false when status is connected", () => {
    const instance = new AcpTranscript();
    instance.status = "connected";
    instance.pendingText = "";
    expect((instance as unknown as { _showThinking: boolean })._showThinking).toBe(false);
  });

  test("_showThinking returns false when status is idle (default)", () => {
    const instance = new AcpTranscript();
    expect((instance as unknown as { _showThinking: boolean })._showThinking).toBe(false);
  });

  test("declares --acp-transcript-* tokens on :host", () => {
    const stylesText = (
      Array.isArray(AcpTranscript.styles) ? AcpTranscript.styles : [AcpTranscript.styles]
    )
      .map((s) => String((s as { cssText?: string }).cssText ?? s))
      .join("\n");
    for (const token of [
      "--acp-transcript-padding",
      "--acp-transcript-empty-color",
      "--acp-transcript-empty-size",
    ]) {
      expect(stylesText).toContain(token);
    }
  });

  test("render template exposes named slots for empty, thinking, and error regions", () => {
    const flatten = (tpl: unknown): string => {
      const t = tpl as { strings?: readonly string[]; values?: readonly unknown[] };
      let src = (t.strings ?? []).join(" ");
      for (const v of t.values ?? []) {
        if (Array.isArray(v)) {
          for (const inner of v) src += ` ${flatten(inner)}`;
        } else if (v && typeof v === "object" && "strings" in (v as object)) {
          src += ` ${flatten(v)}`;
        } else if (typeof v === "string") {
          src += ` ${v}`;
        }
      }
      return src;
    };

    // Empty state
    const emptyInstance = new AcpTranscript();
    emptyInstance.transcript = [];
    emptyInstance.pendingText = "";
    expect(flatten(emptyInstance.render())).toContain('slot name="empty"');

    // Thinking state (status = sending, no pendingText, with at least one transcript entry
    // so hasContent=true and the thinking slot renders)
    const thinkingInstance = new AcpTranscript();
    thinkingInstance.transcript = [{ id: "1", role: "user", text: "hi" } as never];
    thinkingInstance.pendingText = "";
    thinkingInstance.status = "sending";
    expect(flatten(thinkingInstance.render())).toContain('slot name="thinking"');

    // Error state
    const errorInstance = new AcpTranscript();
    errorInstance.transcript = [{ id: "1", role: "user", text: "hi" } as never];
    errorInstance.pendingText = "";
    errorInstance.status = "error";
    errorInstance.lastError = "boom";
    expect(flatten(errorInstance.render())).toContain('slot name="error"');
  });

  test("willUpdate starts and stops the elapsed timer outside updated()", () => {
    const instance = new AcpTranscript() as AcpTranscript & {
      _elapsedSeconds: number;
      _elapsedTimer: ReturnType<typeof setInterval> | null;
      _wasThinking: boolean;
      willUpdate(changed: Map<string, unknown>): void;
    };

    instance.status = "sending";
    instance.pendingText = "";
    instance.willUpdate(new Map([["status", "idle"]]));
    expect(instance._elapsedTimer).not.toBeNull();
    expect(instance._wasThinking).toBe(true);

    instance._elapsedSeconds = 3;
    instance.status = "connected";
    instance.pendingText = "";
    instance.willUpdate(new Map([["status", "sending"]]));

    expect(instance._elapsedTimer).toBeNull();
    expect(instance._elapsedSeconds).toBe(0);
    expect(instance._wasThinking).toBe(false);
  });
});
