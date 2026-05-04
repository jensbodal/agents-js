import { describe, expect, test } from "bun:test";
import { AcpAuthSelector } from "../src/acp-auth-selector.ts";

describe("AcpAuthSelector", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpAuthSelector).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpAuthSelector.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpAuthSelector.styles)).toBe(true);
  });

  test("has reactive property for methods", () => {
    const props = AcpAuthSelector.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("methods")).toBeDefined();
  });

  test("methods property does not reflect to attribute", () => {
    expect(AcpAuthSelector.elementProperties.get("methods")?.attribute).toBe(false);
  });

  test("has reactive property for message", () => {
    expect(AcpAuthSelector.elementProperties.get("message")).toBeDefined();
  });

  test("message property has String type", () => {
    expect(AcpAuthSelector.elementProperties.get("message")?.type).toBe(String);
  });

  test("has exactly 2 element properties", () => {
    expect(AcpAuthSelector.elementProperties.size).toBe(2);
  });

  test("prototype has render method", () => {
    expect(typeof AcpAuthSelector.prototype.render).toBe("function");
  });

  test("prototype has _select method for dispatching events", () => {
    expect(typeof (AcpAuthSelector.prototype as Record<string, unknown>)._select).toBe("function");
  });
});
