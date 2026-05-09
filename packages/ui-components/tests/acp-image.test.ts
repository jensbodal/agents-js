import { describe, expect, test } from "bun:test";
import { AcpImage, registerAllComponents } from "../src/index.ts";

describe("AcpImage", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpImage).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpImage.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpImage.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for src, alt, width, height, loading, aspectRatio, fallback", () => {
    const props = AcpImage.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("src")).toBeDefined();
    expect(props.get("alt")).toBeDefined();
    expect(props.get("width")).toBeDefined();
    expect(props.get("height")).toBeDefined();
    expect(props.get("loading")).toBeDefined();
    expect(props.get("aspectRatio")).toBeDefined();
    expect(props.get("fallback")).toBeDefined();
  });

  test("src property has String type", () => {
    expect(AcpImage.elementProperties.get("src")?.type).toBe(String);
  });

  test("alt property has String type", () => {
    expect(AcpImage.elementProperties.get("alt")?.type).toBe(String);
  });

  test("width property has String type", () => {
    expect(AcpImage.elementProperties.get("width")?.type).toBe(String);
  });

  test("height property has String type", () => {
    expect(AcpImage.elementProperties.get("height")?.type).toBe(String);
  });

  test("loading property has String type", () => {
    expect(AcpImage.elementProperties.get("loading")?.type).toBe(String);
  });

  test("aspectRatio property has String type", () => {
    expect(AcpImage.elementProperties.get("aspectRatio")?.type).toBe(String);
  });

  test("fallback property has String type", () => {
    expect(AcpImage.elementProperties.get("fallback")?.type).toBe(String);
  });
});
