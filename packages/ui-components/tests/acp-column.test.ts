import { describe, expect, test } from "bun:test";
import { AcpColumn, registerAllComponents } from "../src/index.ts";

describe("AcpColumn", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpColumn).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpColumn.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpColumn.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for gap, align, justify", () => {
    const props = AcpColumn.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("gap")).toBeDefined();
    expect(props.get("align")).toBeDefined();
    expect(props.get("justify")).toBeDefined();
  });

  test("gap property has String type", () => {
    expect(AcpColumn.elementProperties.get("gap")?.type).toBe(String);
  });

  test("align property has String type", () => {
    expect(AcpColumn.elementProperties.get("align")?.type).toBe(String);
  });

  test("justify property has String type", () => {
    expect(AcpColumn.elementProperties.get("justify")?.type).toBe(String);
  });

  test("base styles include flex-direction: column", () => {
    const stylesArray = AcpColumn.styles;
    expect(Array.isArray(stylesArray)).toBe(true);
    const css = (stylesArray as Array<{ cssText: string }>).map((s) => s.cssText).join(" ");
    expect(css).toContain("flex-direction");
    expect(css).toContain("column");
  });
});
