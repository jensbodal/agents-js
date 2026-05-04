import { describe, expect, test } from "bun:test";
import { EventSchemas, EventType, RunAgentInputSchema } from "@agents-js/agui-types";

describe("@agents-js/agui-types package import surface", () => {
  test("re-exports @ag-ui/core runtime objects", () => {
    expect(typeof EventSchemas).toBe("object");
    expect(typeof EventType).toBe("object");
    expect(typeof RunAgentInputSchema).toBe("object");
  });

  test("EventSchemas is a zod discriminated union on `type`", () => {
    const result = EventSchemas.safeParse({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call_1",
      delta: "x",
    });
    expect(result.success).toBe(true);
  });
});
