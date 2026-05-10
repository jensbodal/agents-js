import { describe, expect, test } from "bun:test";
import { AcpDiffBlock } from "../src/acp-diff-block.ts";

describe("AcpDiffBlock", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpDiffBlock).toBe("function");
  });

  test("has reactive properties for path / oldText / newText", () => {
    expect(AcpDiffBlock.elementProperties.get("path")).toBeDefined();
    expect(AcpDiffBlock.elementProperties.get("oldText")).toBeDefined();
    expect(AcpDiffBlock.elementProperties.get("newText")).toBeDefined();
  });

  test("default values are empty strings", () => {
    const el = new AcpDiffBlock();
    expect(el.path).toBe("");
    expect(el.oldText).toBe("");
    expect(el.newText).toBe("");
  });
});
