import { describe, expect, test } from "bun:test";
import { resolveBridgeConfigFromEnv } from "../src/env.ts";

describe("resolveBridgeConfigFromEnv", () => {
  test("defaults populate when env is empty", () => {
    const config = resolveBridgeConfigFromEnv({});
    expect(config.gatewayUrl).toBe("http://localhost:8080");
    expect(config.subscribePath).toBe("/events");
    expect(config.filterPrefixes).toEqual(["*"]);
    expect(config.reconnectMinMs).toBe(1_000);
    expect(config.reconnectMaxMs).toBe(60_000);
  });

  test("honors GATEWAY_BUS_URL + GATEWAY_BUS_SUBSCRIBE_PATH", () => {
    const config = resolveBridgeConfigFromEnv({
      GATEWAY_BUS_URL: "http://gw.local:9000",
      GATEWAY_BUS_SUBSCRIBE_PATH: "/v1/events",
    });
    expect(config.gatewayUrl).toBe("http://gw.local:9000");
    expect(config.subscribePath).toBe("/v1/events");
  });

  test("splits GATEWAY_BUS_FILTER on commas with whitespace tolerance", () => {
    const config = resolveBridgeConfigFromEnv({
      GATEWAY_BUS_FILTER: "gateway.matrix., gateway.audit.,gateway.registry. ",
    });
    expect(config.filterPrefixes).toEqual([
      "gateway.matrix.",
      "gateway.audit.",
      "gateway.registry.",
    ]);
  });

  test("treats GATEWAY_BUS_FILTER=* as a single wildcard entry", () => {
    const config = resolveBridgeConfigFromEnv({ GATEWAY_BUS_FILTER: "*" });
    expect(config.filterPrefixes).toEqual(["*"]);
  });

  test("parses numeric reconnect bounds", () => {
    const config = resolveBridgeConfigFromEnv({
      GATEWAY_BUS_RECONNECT_MIN_MS: "500",
      GATEWAY_BUS_RECONNECT_MAX_MS: "30000",
    });
    expect(config.reconnectMinMs).toBe(500);
    expect(config.reconnectMaxMs).toBe(30_000);
  });

  test("throws on non-integer reconnect bound", () => {
    expect(() =>
      resolveBridgeConfigFromEnv({ GATEWAY_BUS_RECONNECT_MIN_MS: "not-a-number" }),
    ).toThrow(/GATEWAY_BUS_RECONNECT_MIN_MS/);
  });

  test("throws on negative reconnect bound", () => {
    expect(() => resolveBridgeConfigFromEnv({ GATEWAY_BUS_RECONNECT_MAX_MS: "-1" })).toThrow(
      /GATEWAY_BUS_RECONNECT_MAX_MS/,
    );
  });

  test("empty filter string falls back to default wildcard", () => {
    const config = resolveBridgeConfigFromEnv({ GATEWAY_BUS_FILTER: "" });
    expect(config.filterPrefixes).toEqual(["*"]);
  });

  test("throws when GATEWAY_BUS_RECONNECT_MIN_MS exceeds MAX_MS", () => {
    expect(() =>
      resolveBridgeConfigFromEnv({
        GATEWAY_BUS_RECONNECT_MIN_MS: "10000",
        GATEWAY_BUS_RECONNECT_MAX_MS: "5000",
      }),
    ).toThrow(/MIN_MS .*must be <= .*MAX_MS/);
  });

  test("accepts MIN_MS == MAX_MS (degenerate fixed-interval reconnect)", () => {
    const config = resolveBridgeConfigFromEnv({
      GATEWAY_BUS_RECONNECT_MIN_MS: "5000",
      GATEWAY_BUS_RECONNECT_MAX_MS: "5000",
    });
    expect(config.reconnectMinMs).toBe(5_000);
    expect(config.reconnectMaxMs).toBe(5_000);
  });
});
