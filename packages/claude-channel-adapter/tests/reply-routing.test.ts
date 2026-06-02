import { describe, expect, test } from "bun:test";
import { replyTargetForRow, resolveReplyTarget } from "../src/reply-routing.ts";

describe("replyTargetForRow", () => {
  test("native agent message → the authoring agent identity", () => {
    expect(replyTargetForRow({ kind: "agents_message", sender: "cognee-claude" })).toBe(
      "cognee-claude",
    );
  });

  test("matrix room mention → the originating room", () => {
    expect(
      replyTargetForRow({
        kind: "matrix_room_mention",
        sender: "agents-gateway-inbox",
        matrix_origin: { room_id: "!room:hs", sender: "@alice:hs" },
      }),
    ).toBe("!room:hs");
  });

  test("matrix origin without room → falls back to the sender mxid", () => {
    expect(replyTargetForRow({ matrix_origin: { sender: "@alice:hs" } })).toBe("@alice:hs");
  });

  test("system/relay row with no addressable origin → undefined", () => {
    // The wake-proof case: sender is the relay, no real author, no matrix origin.
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
