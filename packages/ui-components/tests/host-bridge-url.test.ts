import { describe, expect, test } from "bun:test";
import { normalizeHostBridgeUrl } from "../src/host-bridge-url.ts";

describe("normalizeHostBridgeUrl", () => {
  test("preserves explicit ws and wss URLs", () => {
    expect(normalizeHostBridgeUrl("ws://127.0.0.1:61002")).toBe("ws://127.0.0.1:61002");
    expect(normalizeHostBridgeUrl("wss://example.com/bridge/")).toBe("wss://example.com/bridge");
  });

  test("accepts scheme-less websocket hosts", () => {
    expect(normalizeHostBridgeUrl("127.0.0.1:61002")).toBe("ws://127.0.0.1:61002");
    expect(normalizeHostBridgeUrl("localhost:61002/")).toBe("ws://localhost:61002");
  });

  test("rejects empty and non-websocket URLs", () => {
    expect(normalizeHostBridgeUrl("")).toBeNull();
    expect(normalizeHostBridgeUrl("http://127.0.0.1:61001")).toBeNull();
    expect(normalizeHostBridgeUrl("not a url")).toBeNull();
  });
});
