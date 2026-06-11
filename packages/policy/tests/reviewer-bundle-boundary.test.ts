import { describe, expect, test } from "bun:test";

import type { GuardEvaluation } from "../src/docs-only-path-guard.ts";
import {
  applyReviewerAdvisory,
  isKnownReviewerTag,
  M1_REVIEWER_TAGS,
  type ReviewerAdvisory,
} from "../src/reviewer-bundle-boundary.ts";

const guard = (over: Partial<GuardEvaluation> = {}): GuardEvaluation => ({
  lane: "full-lane",
  guardResult: "not-proven",
  humanReviewRequired: false,
  matchedPaths: [],
  unmatchedPaths: [],
  sensitivePaths: [],
  policyVersion: "docs-only-policy.v0",
  erroredReason: null,
  ...over,
});

const advisory = (over: Partial<ReviewerAdvisory> = {}): ReviewerAdvisory => ({
  advisoryOnly: true,
  tags: [],
  securitySensitive: false,
  confidence: 0,
  ...over,
});

describe("M1 reviewer tag vocabulary", () => {
  test("is exactly the narrowed M1 set", () => {
    expect([...M1_REVIEWER_TAGS]).toEqual(["docs-only", "security-sensitive", "full-lane"]);
  });

  test("rejects tags outside the vocabulary", () => {
    expect(isKnownReviewerTag("docs-only")).toBe(true);
    expect(isKnownReviewerTag("gateway-transport")).toBe(false);
  });
});

describe("applyReviewerAdvisory — Axis A (lane) is the guard's, never the reviewer's", () => {
  test("reviewer cannot DOWNGRADE full-lane to docs-only", () => {
    const d = applyReviewerAdvisory(
      guard({ lane: "full-lane" }),
      advisory({ tags: ["docs-only"], confidence: 0.99 }),
    );
    expect(d.lane).toBe("full-lane");
    expect(d.laneRecomputed).toBe(false);
  });

  test("reviewer cannot UPGRADE docs-only to full-lane", () => {
    const d = applyReviewerAdvisory(
      guard({ lane: "docs-only", guardResult: "proven" }),
      advisory({ tags: ["full-lane"] }),
    );
    expect(d.lane).toBe("docs-only");
  });
});

describe("applyReviewerAdvisory — Axis B (human review) is a one-way ratchet", () => {
  test("reviewer can RAISE human review via security-sensitive", () => {
    const d = applyReviewerAdvisory(guard(), advisory({ securitySensitive: true }));
    expect(d.humanReviewRequired).toBe(true);
  });

  test("reviewer cannot CLEAR a guard-set human-review requirement", () => {
    const d = applyReviewerAdvisory(
      guard({ humanReviewRequired: true }),
      advisory({ securitySensitive: false, tags: ["docs-only"] }),
    );
    expect(d.humanReviewRequired).toBe(true);
  });

  test("escalation applies in BOTH lanes (full-lane + security-sensitive still reviews)", () => {
    const d = applyReviewerAdvisory(
      guard({ lane: "full-lane" }),
      advisory({ securitySensitive: true }),
    );
    expect(d.lane).toBe("full-lane");
    expect(d.humanReviewRequired).toBe(true);
  });
});

describe("applyReviewerAdvisory — fail-closed + confidence-is-not-authority", () => {
  test("unknown tag fails closed to human review and is surfaced", () => {
    const d = applyReviewerAdvisory(guard(), advisory({ tags: ["totally-made-up"] }));
    expect(d.humanReviewRequired).toBe(true);
    expect(d.unknownTags).toEqual(["totally-made-up"]);
    expect(d.advisoryTags).toEqual([]);
  });

  test("high confidence does NOT authorize a lane change", () => {
    const d = applyReviewerAdvisory(
      guard({ lane: "full-lane" }),
      advisory({ tags: ["docs-only"], confidence: 1 }),
    );
    expect(d.lane).toBe("full-lane");
  });

  test("a clean docs-only guard with a clean advisory needs no human review", () => {
    const d = applyReviewerAdvisory(
      guard({ lane: "docs-only", guardResult: "proven" }),
      advisory({ tags: ["docs-only"], confidence: 0.95 }),
    );
    expect(d.humanReviewRequired).toBe(false);
    expect(d.advisoryTags).toEqual(["docs-only"]);
  });
});
