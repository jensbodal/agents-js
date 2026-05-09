import { describe, expect, test } from "bun:test";
import { AcpRow, registerAllComponents } from "../src/index.ts";

describe("AcpRow", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpRow).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpRow.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpRow.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for gap, align, justify, wrap", () => {
    const props = AcpRow.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("gap")).toBeDefined();
    expect(props.get("align")).toBeDefined();
    expect(props.get("justify")).toBeDefined();
    expect(props.get("wrap")).toBeDefined();
  });

  test("gap property has String type", () => {
    expect(AcpRow.elementProperties.get("gap")?.type).toBe(String);
  });

  test("align property has String type", () => {
    expect(AcpRow.elementProperties.get("align")?.type).toBe(String);
  });

  test("justify property has String type", () => {
    expect(AcpRow.elementProperties.get("justify")?.type).toBe(String);
  });

  test("wrap property has Boolean type", () => {
    expect(AcpRow.elementProperties.get("wrap")?.type).toBe(Boolean);
  });

  test("base styles include flex-direction: row", () => {
    const stylesArray = AcpRow.styles;
    expect(Array.isArray(stylesArray)).toBe(true);
    const css = (stylesArray as Array<{ cssText: string }>).map((s) => s.cssText).join(" ");
    expect(css).toContain("flex-direction");
    expect(css).toContain("row");
  });
});
