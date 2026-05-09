import { describe, expect, test } from "bun:test";
import { AcpStatusBar } from "../src/acp-status-bar.ts";

describe("AcpStatusBar", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpStatusBar).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpStatusBar.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpStatusBar.styles)).toBe(true);
  });

  test("has reactive properties for agentName, status, sessionId", () => {
    const props = AcpStatusBar.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("agentName")).toBeDefined();
    expect(props.get("status")).toBeDefined();
    expect(props.get("sessionId")).toBeDefined();
  });

  test("agentName property has String type", () => {
    expect(AcpStatusBar.elementProperties.get("agentName")?.type).toBe(String);
  });

  test("status property has String type", () => {
    expect(AcpStatusBar.elementProperties.get("status")?.type).toBe(String);
  });

  test("sessionId property has String type", () => {
    expect(AcpStatusBar.elementProperties.get("sessionId")?.type).toBe(String);
  });

  test("profileName property has String type", () => {
    expect(AcpStatusBar.elementProperties.get("profileName")?.type).toBe(String);
  });

  test("has exactly 5 element properties (no internal state)", () => {
    expect(AcpStatusBar.elementProperties.size).toBe(5);
  });
});

describe("AcpStatusBar theming contract", () => {
  const stylesText = (
    Array.isArray(AcpStatusBar.styles) ? AcpStatusBar.styles : [AcpStatusBar.styles]
  )
    .map((s) => String((s as { cssText?: string }).cssText ?? s))
    .join("\n");

  test("declares --acp-status-bar-* tokens on :host", () => {
    for (const token of [
      "--acp-status-bar-bg",
      "--acp-status-bar-border",
      "--acp-status-bar-padding",
      "--acp-status-bar-gap",
      "--acp-status-bar-font-size",
      "--acp-status-bar-color",
    ]) {
      expect(stylesText).toContain(token);
    }
  });

  test("render template exposes named slots (leading, badge, trailing) with default content", () => {
    const bar = new AcpStatusBar();
    bar.agentName = "Test";
    bar.status = "connected";
    bar.sessionId = "abcdef1234";
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
    const src = flatten(bar.render());
    expect(src).toContain('slot name="leading"');
    expect(src).toContain('slot name="badge"');
    expect(src).toContain('slot name="trailing"');
    // A default (unnamed) slot is also present for host-provided extras.
    expect(src).toContain("<slot></slot>");
  });
});
