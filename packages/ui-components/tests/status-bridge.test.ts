import { describe, expect, test } from "bun:test";
import { deriveDisplayedSessionStatus } from "../src/status-bridge.ts";

describe("deriveDisplayedSessionStatus", () => {
  test("falls back to the controller status when the host has no override", () => {
    expect(deriveDisplayedSessionStatus("connected", null)).toBe("connected");
    expect(deriveDisplayedSessionStatus("waiting", undefined)).toBe("waiting");
  });

  test("maps host readiness states onto the browser shell status vocabulary", () => {
    expect(deriveDisplayedSessionStatus("connected", "ready")).toBe("connected");
    expect(deriveDisplayedSessionStatus("connected", "prompting")).toBe("waiting");
    expect(deriveDisplayedSessionStatus("connected", "cancelling")).toBe("waiting");
    expect(deriveDisplayedSessionStatus("connected", "waiting_permission")).toBe("input_required");
    expect(deriveDisplayedSessionStatus("connected", "waiting_elicitation")).toBe("input_required");
    expect(deriveDisplayedSessionStatus("connected", "initializing")).toBe("connecting");
    expect(deriveDisplayedSessionStatus("connected", "loading")).toBe("connecting");
    expect(deriveDisplayedSessionStatus("connected", "error")).toBe("error");
    expect(deriveDisplayedSessionStatus("connected", "closed")).toBe("idle");
  });
});
