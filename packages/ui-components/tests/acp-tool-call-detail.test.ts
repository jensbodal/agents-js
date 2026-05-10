import { describe, expect, test } from "bun:test";
import { AcpToolCallDetail, type AcpToolCallDetailData } from "../src/acp-tool-call-detail.ts";

describe("AcpToolCallDetail", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpToolCallDetail).toBe("function");
  });

  test("toolCall property is reactive but not attribute-bound", () => {
    const prop = AcpToolCallDetail.elementProperties.get("toolCall");
    expect(prop).toBeDefined();
    // attribute: false because the value contains nested arrays /
    // arbitrary `unknown` rawInput/rawOutput that don't serialize
    // through DOM attributes.
    expect(prop?.attribute).toBe(false);
  });

  test("toolCall defaults to undefined (no render)", () => {
    const el = new AcpToolCallDetail();
    expect(el.toolCall).toBeUndefined();
  });

  test("AcpToolCallDetailData type accepts all ACP fields", () => {
    // Compile-time check: building a value with every optional field
    // covered. If the type definition drifts away from `ActiveToolCall`,
    // this fixture stops compiling.
    const tc: AcpToolCallDetailData = {
      toolCallId: "tc1",
      toolName: "read_file",
      status: "in_progress",
      startedAt: 1_700_000_000_000,
      toolKind: "read",
      content: [{ type: "content", content: { type: "text", text: "x" } }],
      locations: [{ path: "/a.ts", line: 1 }],
      rawInput: { path: "/a.ts" },
      rawOutput: "result",
    };
    expect(tc.toolCallId).toBe("tc1");
  });

  test("AcpToolCallDetailData accepts null content/locations (explicit clear)", () => {
    const tc: AcpToolCallDetailData = {
      toolCallId: "tc1",
      toolName: "read_file",
      status: "in_progress",
      content: null,
      locations: null,
    };
    expect(tc.content).toBeNull();
    expect(tc.locations).toBeNull();
  });
});
