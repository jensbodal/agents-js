import { describe, expect, test } from "bun:test";
import { buildDemoMessages } from "../src/a2ui-demo.ts";

describe("a2ui demo", () => {
  test("uses a directly renderable root primitive for browser inspection", () => {
    // WHAT: the dev-only ?a2ui=demo surface should visibly render its demo message
    // without requiring a live ACP controller or connected chat session.
    // WHY: the manual browser pass found that rooting the demo on AcpChatApp
    // rendered a second connection dialog instead of the intended A2UI surface.
    const update = buildDemoMessages().find((message) => "updateComponents" in message);
    const components = update?.updateComponents?.components ?? [];

    expect(components[0]?.component).toBe("AcpMessage");
    expect(components[0]).toMatchObject({
      role: "agent",
      body: "Hello from the A2UI demo surface!",
    });
  });
});
