import { describe, expect, test } from "bun:test";
import { AcpToolKindIcon } from "../src/acp-tool-kind-icon.ts";

describe("AcpToolKindIcon", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpToolKindIcon).toBe("function");
  });

  test("has reactive property for kind", () => {
    expect(AcpToolKindIcon.elementProperties.get("kind")).toBeDefined();
  });

  test("kind defaults to 'other'", () => {
    const el = new AcpToolKindIcon();
    expect(el.kind).toBe("other");
  });

  test("static styles include theme tokens", () => {
    expect(Array.isArray(AcpToolKindIcon.styles)).toBe(true);
  });
});
