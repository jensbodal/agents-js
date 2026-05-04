import { describe, expect, test } from "bun:test";
import { AcpButton, registerAllComponents } from "../src/index.ts";

describe("AcpButton", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpButton).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpButton.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpButton.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for variant, size, disabled, loading, label", () => {
    const props = AcpButton.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("variant")).toBeDefined();
    expect(props.get("size")).toBeDefined();
    expect(props.get("disabled")).toBeDefined();
    expect(props.get("loading")).toBeDefined();
    expect(props.get("label")).toBeDefined();
  });

  test("variant property has String type", () => {
    expect(AcpButton.elementProperties.get("variant")?.type).toBe(String);
  });

  test("size property has String type", () => {
    expect(AcpButton.elementProperties.get("size")?.type).toBe(String);
  });

  test("disabled property has Boolean type", () => {
    expect(AcpButton.elementProperties.get("disabled")?.type).toBe(Boolean);
  });

  test("loading property has Boolean type", () => {
    expect(AcpButton.elementProperties.get("loading")?.type).toBe(Boolean);
  });

  test("label property has String type", () => {
    expect(AcpButton.elementProperties.get("label")?.type).toBe(String);
  });
});
