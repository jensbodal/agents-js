import { describe, expect, test } from "bun:test";
import { AcpDivider, registerAllComponents } from "../src/index.ts";

describe("AcpDivider", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpDivider).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpDivider.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpDivider.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for orientation and spacing", () => {
    const props = AcpDivider.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("orientation")).toBeDefined();
    expect(props.get("spacing")).toBeDefined();
  });

  test("orientation property has String type", () => {
    expect(AcpDivider.elementProperties.get("orientation")?.type).toBe(String);
  });

  test("spacing property has String type", () => {
    expect(AcpDivider.elementProperties.get("spacing")?.type).toBe(String);
  });

  test("orientation property is reflected", () => {
    expect(AcpDivider.elementProperties.get("orientation")?.reflect).toBe(true);
  });
});
