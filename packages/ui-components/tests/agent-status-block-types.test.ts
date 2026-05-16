import { describe, expect, test } from "bun:test";
import {
  deriveAgentVisualState,
  formatActivityAge,
  type StatusSnapshotAgent,
} from "../src/agent-status-block-types.ts";

const basis = (overrides: Partial<StatusSnapshotAgent>): StatusSnapshotAgent => ({
  name: "test-agent",
  mxid: "@test:matrix.example",
  online: true,
  ...overrides,
});

describe("deriveAgentVisualState — bucketing across the four states", () => {
  test("online + activity well under default 300s threshold → online-active", () => {
    const visual = deriveAgentVisualState(basis({ online: true, activity_age_seconds: 12 }));
    expect(visual.state).toBe("online-active");
    expect(visual.stateLabel).toBe("Active");
  });

  test("online + activity above default threshold → online-idle", () => {
    const visual = deriveAgentVisualState(basis({ online: true, activity_age_seconds: 642 }));
    expect(visual.state).toBe("online-idle");
    expect(visual.stateLabel).toBe("Idle");
  });

  test("online + activity exactly at threshold → online-idle (half-open boundary)", () => {
    const visual = deriveAgentVisualState(basis({ online: true, activity_age_seconds: 300 }));
    expect(visual.state).toBe("online-idle");
  });

  test("online + no activity reading → online-idle (cannot prove active)", () => {
    const visual = deriveAgentVisualState(basis({ online: true, activity_age_seconds: undefined }));
    expect(visual.state).toBe("online-idle");
    expect(visual.activityLabel).toBe("unknown");
  });

  test("offline + activity inside stale threshold → offline-recent", () => {
    const visual = deriveAgentVisualState(basis({ online: false, activity_age_seconds: 600 }));
    expect(visual.state).toBe("offline-recent");
    expect(visual.stateLabel).toBe("Offline");
  });

  test("offline + activity past stale threshold → offline-stale", () => {
    const visual = deriveAgentVisualState(basis({ online: false, activity_age_seconds: 14_400 }));
    expect(visual.state).toBe("offline-stale");
    expect(visual.stateLabel).toBe("Offline · stale");
  });

  test("offline + no activity reading → offline-stale (treated as unknown-since-long-ago)", () => {
    const visual = deriveAgentVisualState(
      basis({ online: false, activity_age_seconds: undefined }),
    );
    expect(visual.state).toBe("offline-stale");
  });
});

describe("deriveAgentVisualState — caller-supplied thresholds override defaults", () => {
  test("a longer active window keeps a previously-idle agent active", () => {
    const visual = deriveAgentVisualState(basis({ online: true, activity_age_seconds: 600 }), {
      activeThresholdSeconds: 1200,
    });
    expect(visual.state).toBe("online-active");
  });

  test("a shorter stale window flips a previously-recent offline agent to stale", () => {
    const visual = deriveAgentVisualState(basis({ online: false, activity_age_seconds: 600 }), {
      staleThresholdSeconds: 300,
    });
    expect(visual.state).toBe("offline-stale");
  });
});

describe("formatActivityAge", () => {
  test("undefined → 'unknown' (signals absence, not zero)", () => {
    expect(formatActivityAge(undefined)).toBe("unknown");
  });

  test("seconds under a minute render as 'Ns ago'", () => {
    expect(formatActivityAge(12)).toBe("12s ago");
    expect(formatActivityAge(59.9)).toBe("59s ago");
  });

  test("seconds in [60, 3600) render as 'Nm ago'", () => {
    expect(formatActivityAge(60)).toBe("1m ago");
    expect(formatActivityAge(3599)).toBe("59m ago");
  });

  test("seconds in [3600, 86400) render as 'Nh ago'", () => {
    expect(formatActivityAge(3600)).toBe("1h ago");
    expect(formatActivityAge(86_399)).toBe("23h ago");
  });

  test("seconds at or above 86400 render as 'Nd ago'", () => {
    expect(formatActivityAge(86_400)).toBe("1d ago");
    expect(formatActivityAge(86_400 * 2.5)).toBe("2d ago");
  });
});
