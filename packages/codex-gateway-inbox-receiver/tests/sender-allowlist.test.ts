import { describe, expect, test } from "bun:test";
import { parseSenderAllowlist, senderAllowed } from "../src/sender-allowlist.ts";

describe("sender allowlist", () => {
  test("documents default-deny behavior for untrusted gateway inbox rows", () => {
    expect(senderAllowed("ajs-claude", parseSenderAllowlist(undefined))).toBe(false);

    const allowlist = parseSenderAllowlist("ajs-claude,hostname-null-claude-0 @alice:hs");
    expect(senderAllowed("ajs-claude", allowlist)).toBe(true);
    expect(senderAllowed("@alice:hs", allowlist)).toBe(true);
    expect(senderAllowed("unknown-agent", allowlist)).toBe(false);
  });
});
