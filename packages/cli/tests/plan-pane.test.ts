import { describe, expect, test } from "bun:test";
import type { A2ASessionState } from "@agents-js/a2a-client";
import { createTestRenderer } from "@opentui/core/testing";
import { createClientPlanPane } from "../src/client/ui/plan-pane.ts";

function baseState(overrides: Partial<A2ASessionState> = {}): A2ASessionState {
  return {
    sessionId: "s1",
    transcript: [],
    status: "connected",
    debugRecords: [],
    activeToolCalls: [],
    completedToolCalls: [],
    currentPlan: null,
    availableCommands: [],
    ...overrides,
  };
}

describe("plan-pane", () => {
  test("renders no rows when currentPlan is null", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 60, height: 6 });
    const pane = createClientPlanPane(renderer);
    renderer.root.add(pane.root);

    pane.update(baseState());
    await renderOnce();

    expect(pane.root.getChildren()).toHaveLength(0);
  });

  test("renders one row per entry with status glyph and priority tag", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 60,
      height: 6,
    });
    const pane = createClientPlanPane(renderer);
    renderer.root.add(pane.root);

    pane.update(
      baseState({
        currentPlan: [
          { content: "research", status: "completed", priority: "high" },
          { content: "implement", status: "in_progress", priority: "medium" },
          { content: "ship", status: "pending", priority: "low" },
        ],
      }),
    );
    await renderOnce();

    expect(pane.root.getChildren()).toHaveLength(3);
    const frame = captureCharFrame();
    // Glyphs reflect status.
    expect(frame).toContain("[x] research (high)");
    expect(frame).toContain("[~] implement (medium)");
    expect(frame).toContain("[ ] ship (low)");
  });

  test("rebuilds rows when plan replaced wholesale", async () => {
    const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
      width: 60,
      height: 6,
    });
    const pane = createClientPlanPane(renderer);
    renderer.root.add(pane.root);

    pane.update(
      baseState({
        currentPlan: [{ content: "first plan", status: "in_progress", priority: "high" }],
      }),
    );
    await renderOnce();
    expect(captureCharFrame()).toContain("first plan");

    pane.update(
      baseState({
        currentPlan: [
          { content: "second plan a", status: "completed", priority: "low" },
          { content: "second plan b", status: "pending", priority: "low" },
        ],
      }),
    );
    await renderOnce();

    const frame = captureCharFrame();
    // Old entries gone; new entries present.
    expect(frame).not.toContain("first plan");
    expect(frame).toContain("second plan a");
    expect(frame).toContain("second plan b");
    expect(pane.root.getChildren()).toHaveLength(2);
  });

  test("collapses to zero rows when plan transitions back to null", async () => {
    const { renderer, renderOnce } = await createTestRenderer({ width: 60, height: 6 });
    const pane = createClientPlanPane(renderer);
    renderer.root.add(pane.root);

    pane.update(
      baseState({
        currentPlan: [{ content: "step", status: "pending", priority: "low" }],
      }),
    );
    await renderOnce();
    expect(pane.root.getChildren()).toHaveLength(1);

    pane.update(baseState({ currentPlan: null }));
    await renderOnce();
    expect(pane.root.getChildren()).toHaveLength(0);
  });
});
