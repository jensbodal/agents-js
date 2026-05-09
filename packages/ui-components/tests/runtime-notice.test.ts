import { describe, expect, test } from "bun:test";
import { deriveRuntimeNotice } from "../src/runtime-notice.ts";

describe("deriveRuntimeNotice", () => {
  test("hides runtime notices when host state is not being shown", () => {
    expect(
      deriveRuntimeNotice(false, {
        status: "failed",
        requestedRuntimeId: "claude",
        message: "Switch failed.",
      }),
    ).toBe("");
  });

  test("hides runtimeApplied notices when no prompts were cleared", () => {
    expect(
      deriveRuntimeNotice(true, {
        status: "runtimeApplied",
        requestedRuntimeId: "claude",
        message: "Switched cleanly.",
        clearedPendingTurn: false,
      }),
    ).toBe("");
  });

  test("keeps runtimeApplied notices visible when queued or in-flight work was cleared", () => {
    expect(
      deriveRuntimeNotice(true, {
        status: "runtimeApplied",
        requestedRuntimeId: "claude",
        message: "Switched. In-flight or queued prompts were cleared.",
        clearedPendingTurn: true,
      }),
    ).toBe("Switched. In-flight or queued prompts were cleared.");
  });

  test("keeps non-success runtime notices visible", () => {
    expect(
      deriveRuntimeNotice(true, {
        status: "runtimeUnsupported",
        requestedRuntimeId: "claude",
        message: "Runtime hot-swap is unavailable.",
      }),
    ).toBe("Runtime hot-swap is unavailable.");
  });
});
