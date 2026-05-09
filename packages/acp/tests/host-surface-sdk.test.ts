import { describe, expect, test } from "bun:test";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionNotification,
  type SessionUpdate,
} from "@agents-js/acp";

/**
 * WHAT: Pin that the SDK pass-through surface from `@agentclientprotocol/sdk`
 * is reachable through the `@agents-js/acp` barrel.
 * WHY: These five names participate in the documented host-facing surface.
 * If a future refactor of `host-surface-sdk.ts` or `index.ts` drops the
 * re-export, hosts importing from `@agents-js/acp` would fail at compile
 * time. This test catches that statically (`SessionNotification` /
 * `SessionUpdate` are types — `import` would fail) and at runtime
 * (`ClientSideConnection` etc. must resolve to a value).
 */
describe("@agents-js/acp host-surface-sdk re-exports", () => {
  test("value re-exports resolve at runtime", () => {
    expect(typeof ClientSideConnection).toBe("function");
    expect(typeof ndJsonStream).toBe("function");
    expect(typeof PROTOCOL_VERSION).toBe("number");
  });

  test("type re-exports are usable in type position", () => {
    // The compile-time check IS the test — if `SessionNotification` or
    // `SessionUpdate` were not re-exported, `tsgo --noEmit` would fail
    // and `bun test` would not even reach this body. Use them in type
    // positions to keep them "live."
    const _check: SessionNotification | undefined = undefined;
    const _check2: SessionUpdate | undefined = undefined;
    expect(_check).toBeUndefined();
    expect(_check2).toBeUndefined();
  });
});
