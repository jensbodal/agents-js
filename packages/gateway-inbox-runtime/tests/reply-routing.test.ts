import { describe, expect, test } from "bun:test";
import { replyTargetForRow, resolveReplyTarget } from "../src/reply-routing.ts";

describe("replyTargetForRow", () => {
  test("native agent message → the authoring agent identity (a directory name)", () => {
    expect(replyTargetForRow({ sender: "cognee-claude" })).toBe("cognee-claude");
  });

  test("sender that is a raw mxid → undefined (not directory-routable)", () => {
    // The gateway resolves targets by entity name; a raw @mxid 404s, so it is
    // not returned — the caller falls through to an explicit target/fallback.
    expect(replyTargetForRow({ sender: "@alice:hs" })).toBeUndefined();
  });

  test("sender that is a raw room id → undefined (not directory-routable)", () => {
    expect(replyTargetForRow({ sender: "!room:hs" })).toBeUndefined();
  });

  test("system/relay row with no sender → undefined", () => {
    // The wake-proof case: no real author travels on the row.
    expect(replyTargetForRow({})).toBeUndefined();
  });
});

describe("resolveReplyTarget", () => {
  test("explicit target wins over inbound and fallback", () => {
    expect(resolveReplyTarget("explicit", "inbound", "fallback")).toBe("explicit");
  });

  test("falls back to the last inbound target when no explicit target", () => {
    expect(resolveReplyTarget(undefined, "inbound", "fallback")).toBe("inbound");
  });

  test("falls back to the coordinator when no explicit or inbound target", () => {
    expect(resolveReplyTarget(undefined, undefined, "coordinator")).toBe("coordinator");
  });

  test("undefined when nothing is routable", () => {
    expect(resolveReplyTarget(undefined, undefined, undefined)).toBeUndefined();
  });
});
