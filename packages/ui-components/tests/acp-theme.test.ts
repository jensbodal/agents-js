import { describe, expect, test } from "bun:test";
import { CSSResult } from "lit";
import { acpTheme } from "../src/acp-theme.ts";

describe("acpTheme", () => {
  test("export exists and is defined", () => {
    expect(acpTheme).toBeDefined();
  });

  test("is an instance of CSSResult", () => {
    expect(acpTheme).toBeInstanceOf(CSSResult);
  });

  test("contains expected CSS custom properties", () => {
    const cssText = acpTheme.cssText;
    expect(cssText).toContain("--acp-bg:");
    expect(cssText).toContain("--acp-text:");
    expect(cssText).toContain("--acp-accent:");
    expect(cssText).toContain("--acp-border:");
    expect(cssText).toContain("--acp-success:");
    expect(cssText).toContain("--acp-error:");
    expect(cssText).toContain("--acp-bg-secondary:");
    expect(cssText).toContain("--acp-bg-tertiary:");
    expect(cssText).toContain("--acp-text-muted:");
    expect(cssText).toContain("--acp-accent-purple:");
    expect(cssText).toContain("--acp-accent-gold:");
  });

  test("uses :host selector", () => {
    const cssText = acpTheme.cssText;
    expect(cssText).toContain(":host");
  });

  test("uses double-var pattern for overridability", () => {
    const cssText = acpTheme.cssText;
    // Each property should reference a var(--acp-color-*, ...) fallback
    expect(cssText).toContain("var(--acp-color-bg,");
    expect(cssText).toContain("var(--acp-color-text,");
    expect(cssText).toContain("var(--acp-color-accent,");
  });
});
