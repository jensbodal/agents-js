import { describe, expect, test } from "bun:test";
import { mapPermissionRequest } from "../src/ws-state-mapper.ts";

describe("mapPermissionRequest", () => {
  test("forwards title + rawInput (existing behavior)", () => {
    const result = mapPermissionRequest({
      toolCall: { title: "Read /tmp/x", rawInput: { path: "/tmp/x" } },
    });
    expect(result.toolCall?.title).toBe("Read /tmp/x");
    expect(result.toolCall?.rawInput).toEqual({ path: "/tmp/x" });
  });

  test("forwards full ToolCallUpdate surface (Layer C fidelity)", () => {
    // Pre-fix this test would lose toolCallId / status / kind / locations /
    // rawOutput / content because the mapper only carried title + rawInput.
    // acp-host 0.4.0 surfaces all of these on `ToolCallInfo`; the modal
    // needs `toolCallId` for live-call correlation, `status` for the
    // execution-state badge, the rest for follow-along, raw I/O display,
    // and rich body rendering.
    const result = mapPermissionRequest({
      toolCall: {
        toolCallId: "tc-abc-123",
        title: "Edit src/app.ts",
        status: "in_progress",
        kind: "edit",
        locations: [{ path: "/work/src/app.ts", line: 42 }, { path: "/work/src/other.ts" }],
        rawInput: { path: "/work/src/app.ts", oldText: "a", newText: "b" },
        rawOutput: { applied: true },
        content: [
          {
            type: "diff",
            path: "/work/src/app.ts",
            oldText: "a",
            newText: "b",
          },
        ],
      },
    });

    expect(result.toolCall?.toolCallId).toBe("tc-abc-123");
    expect(result.toolCall?.title).toBe("Edit src/app.ts");
    expect(result.toolCall?.status).toBe("in_progress");
    expect(result.toolCall?.kind).toBe("edit");
    expect(result.toolCall?.locations).toEqual([
      { path: "/work/src/app.ts", line: 42 },
      { path: "/work/src/other.ts" },
    ]);
    expect(result.toolCall?.rawInput).toEqual({
      path: "/work/src/app.ts",
      oldText: "a",
      newText: "b",
    });
    expect(result.toolCall?.rawOutput).toEqual({ applied: true });
    expect(result.toolCall?.content).toEqual([
      { type: "diff", path: "/work/src/app.ts", oldText: "a", newText: "b" },
    ]);
  });

  test("rejects non-array locations and content (drops silently rather than corrupting)", () => {
    const result = mapPermissionRequest({
      toolCall: {
        title: "Bad payload",
        locations: "not-an-array",
        content: { wrong: "shape" },
      },
    });

    expect(result.toolCall?.title).toBe("Bad payload");
    expect(result.toolCall?.locations).toBeUndefined();
    expect(result.toolCall?.content).toBeUndefined();
  });

  test("filters malformed elements out of locations and content arrays", () => {
    // Downstream renderers read `loc.path` and `block.type` unguarded —
    // a string/null slipping through would crash the modal. The mapper
    // must drop elements that don't match the documented element shape
    // even when the outer array is well-formed. Locations are narrowed
    // via `rehydrateLocations` (path: string + optional numeric line);
    // content blocks are narrowed against the `ToolCallContent`
    // discriminator union (`"content" | "diff" | "terminal"`).
    const result = mapPermissionRequest({
      toolCall: {
        title: "Mixed payload",
        locations: [
          { path: "/work/src/app.ts", line: 1 },
          "not-an-object",
          null,
          { line: 2 }, // missing required `path`
          { path: 7 }, // wrong type for `path`
          { path: "/work/src/other.ts", line: "12" }, // wrong type for `line` — line dropped, path kept
        ],
        content: [
          { type: "content", content: { type: "text", text: "ok" } },
          { type: "diff", path: "/x", oldText: null, newText: "y" },
          "lone-string",
          null,
          { type: "text", text: "wrong-discriminator" }, // not part of the ToolCallContent union
          { kind: "diff" }, // missing required `type`
          { type: "image" }, // unknown discriminator
          { type: "diff" }, // diff missing required `path` + `newText`
          { type: "diff", path: "/y" }, // diff missing required `newText`
          { type: "terminal" }, // terminal missing required `terminalId`
          { type: "content", content: null }, // content missing nested block
          { type: "content", content: { text: "no-type" } }, // content nested block missing `type`
        ],
      },
    });

    expect(result.toolCall?.locations).toEqual([
      { path: "/work/src/app.ts", line: 1 },
      { path: "/work/src/other.ts" }, // `line` dropped because it was a string
    ]);
    expect(result.toolCall?.content).toEqual([
      { type: "content", content: { type: "text", text: "ok" } },
      { type: "diff", path: "/x", oldText: null, newText: "y" },
    ]);
  });

  test("drops non-string toolCallId and status (defensive at the wire boundary)", () => {
    const result = mapPermissionRequest({
      toolCall: {
        title: "Bad scalars",
        toolCallId: 42,
        status: { phase: "weird" },
      },
    });

    expect(result.toolCall?.title).toBe("Bad scalars");
    expect(result.toolCall?.toolCallId).toBeUndefined();
    expect(result.toolCall?.status).toBeUndefined();
  });

  test("forwards message + options + suggestedScopes", () => {
    const result = mapPermissionRequest({
      toolCall: { title: "Run bash" },
      message: "Allow shell access?",
      options: [
        { optionId: "allow", kind: "allow_once", name: "Allow", description: "Once" },
        { optionId: "deny", kind: "reject_once" },
      ],
      suggestedScopes: [
        { level: "session", scope: "shell:*", label: "Allow shell for this session" },
        { level: "skip", scope: "ignored", label: "Skip elevation for this turn" },
      ],
    });

    expect(result.message).toBe("Allow shell access?");
    expect(result.options).toHaveLength(2);
    expect(result.options?.[0]).toEqual({
      optionId: "allow",
      kind: "allow_once",
      name: "Allow",
      description: "Once",
    });
    expect(result.suggestedScopes).toHaveLength(2);
  });

  test("returns empty result when raw has nothing useful", () => {
    expect(mapPermissionRequest({})).toEqual({});
  });
});
