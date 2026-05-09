import { describe, expect, test } from "bun:test";
import type { RenderDescriptor } from "../src/types/render-descriptor.ts";

describe("RenderDescriptor types", () => {
  test("text descriptor is valid", () => {
    const d: RenderDescriptor = { type: "text", markdown: "# Hello" };
    expect(d.type).toBe("text");
  });

  test("code descriptor is valid", () => {
    const d: RenderDescriptor = { type: "code", language: "typescript", code: "const x = 1;" };
    expect(d.type).toBe("code");
  });

  test("discriminated union exhaustive check compiles", () => {
    function render(d: RenderDescriptor): string {
      switch (d.type) {
        case "text":
          return d.markdown;
        case "code":
          return d.code;
        case "diff":
          return d.path;
        case "terminal":
          return d.sessionId;
        case "form":
          return JSON.stringify(d.schema);
        case "component":
          return d.tag;
      }
    }
    expect(render({ type: "text", markdown: "test" })).toBe("test");
  });
});
