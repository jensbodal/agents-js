/**
 * Tests for the agent inbox config parser (`apps/web-ui/src/inbox-config.ts`).
 *
 * Locks the typed-error contract: parse failures return a discriminated
 * {@link InboxConfigError} with a stable `code` (not a bare string), so the
 * call site can switch on / log the code. The default gateway origin is
 * injected, keeping the parser pure and DOM-free.
 */
import { describe, expect, test } from "bun:test";
import {
  type InboxBrowserConfig,
  isInboxConfigError,
  parseInboxConfig,
} from "../src/inbox-config.ts";

const ORIGIN = "https://gateway.example";

describe("parseInboxConfig", () => {
  test("returns a typed missing-token error when token is absent", () => {
    const result = parseInboxConfig("#target=sess-a", ORIGIN);
    expect(isInboxConfigError(result)).toBe(true);
    if (!isInboxConfigError(result)) throw new Error("expected a config error");
    expect(result.code).toBe("inbox/missing-token");
    expect(result.message).toContain("token");
  });

  test("returns a typed invalid-limit error for non-positive / non-numeric limit", () => {
    for (const bad of ["0", "-3", "abc"]) {
      const result = parseInboxConfig(`#token=jwt&limit=${bad}`, ORIGIN);
      expect(isInboxConfigError(result)).toBe(true);
      if (!isInboxConfigError(result)) throw new Error(`expected error for limit=${bad}`);
      expect(result.code).toBe("inbox/invalid-limit");
    }
  });

  test("parses a valid config, defaulting gateway to the injected origin", () => {
    const result = parseInboxConfig("#token=jwt-123", ORIGIN);
    expect(isInboxConfigError(result)).toBe(false);
    const config = result as InboxBrowserConfig;
    expect(config.token).toBe("jwt-123");
    expect(config.gatewayUrl).toBe(ORIGIN);
    expect(config.target).toBeUndefined();
    expect(config.limit).toBeUndefined();
  });

  test("honors explicit gateway, target, and limit", () => {
    const result = parseInboxConfig(
      "#token=jwt&gateway=https://g.example&target=sess-x&limit=50",
      ORIGIN,
    );
    expect(isInboxConfigError(result)).toBe(false);
    const config = result as InboxBrowserConfig;
    expect(config.gatewayUrl).toBe("https://g.example");
    expect(config.target).toBe("sess-x");
    expect(config.limit).toBe(50);
  });

  test("tolerates a hash with no leading '#'", () => {
    const result = parseInboxConfig("token=jwt", ORIGIN);
    expect(isInboxConfigError(result)).toBe(false);
    expect((result as InboxBrowserConfig).token).toBe("jwt");
  });
});
