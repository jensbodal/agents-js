import { afterEach, describe, expect, test } from "bun:test";
import {
  AcpIcon,
  clearIconRegistries,
  registerAllComponents,
  registerIconSet,
} from "../src/index.ts";

describe("AcpIcon", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpIcon).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpIcon.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpIcon.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for name, size, color", () => {
    const props = AcpIcon.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("name")).toBeDefined();
    expect(props.get("size")).toBeDefined();
    expect(props.get("color")).toBeDefined();
  });

  test("name property has String type", () => {
    expect(AcpIcon.elementProperties.get("name")?.type).toBe(String);
  });

  test("size property has String type", () => {
    expect(AcpIcon.elementProperties.get("size")?.type).toBe(String);
  });

  test("size property is reflected to attribute", () => {
    expect(AcpIcon.elementProperties.get("size")?.reflect).toBe(true);
  });

  test("color property has String type", () => {
    expect(AcpIcon.elementProperties.get("color")?.type).toBe(String);
  });
});

describe("AcpIcon registry", () => {
  afterEach(() => {
    clearIconRegistries();
  });

  test("registerIconSet and clearIconRegistries are exported functions", () => {
    expect(typeof registerIconSet).toBe("function");
    expect(typeof clearIconRegistries).toBe("function");
  });

  test("registerIconSet does not throw", () => {
    expect(() => registerIconSet({ custom: "M0 0L24 24" })).not.toThrow();
  });

  test("clearIconRegistries does not throw", () => {
    registerIconSet({ custom: "M0 0L24 24" });
    expect(() => clearIconRegistries()).not.toThrow();
  });

  test("multiple registries can be registered without error", () => {
    expect(() => {
      registerIconSet({ a: "M0 0" });
      registerIconSet({ b: "M1 1" });
    }).not.toThrow();
  });
});
