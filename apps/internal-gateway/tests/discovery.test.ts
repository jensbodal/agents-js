import { describe, expect, test } from "bun:test";
import {
  buildGatewayDiscovery,
  formatGatewayDiscoveryLines,
  parseGatewayPort,
  parseNonNegativeInteger,
  resolveGatewayPort,
  resolveGatewayPublicUrl,
} from "../discovery.ts";

describe("parseGatewayPort", () => {
  test("accepts integer ports including 0 for dynamic discovery", () => {
    expect(parseGatewayPort("0", "--port")).toBe(0);
    expect(parseGatewayPort("61001", "--port")).toBe(61001);
  });

  test("rejects invalid values", () => {
    expect(() => parseGatewayPort("-1", "--port")).toThrow();
    expect(() => parseGatewayPort("70000", "--port")).toThrow();
    expect(() => parseGatewayPort("abc", "--port")).toThrow();
  });

  test("rejects parseInt-permissive shapes that are not exact-digit ports", () => {
    // These are all inputs `Number.parseInt(_, 10)` would silently accept by
    // parsing a prefix; the digit-only guard rejects them up-front.
    expect(() => parseGatewayPort("3000abc", "--port")).toThrow();
    expect(() => parseGatewayPort("3.14", "--port")).toThrow();
    expect(() => parseGatewayPort("+3000", "--port")).toThrow();
    expect(() => parseGatewayPort("0x10", "--port")).toThrow();
    expect(() => parseGatewayPort("3e2", "--port")).toThrow();
    expect(() => parseGatewayPort("", "--port")).toThrow();
    expect(() => parseGatewayPort("   ", "--port")).toThrow();
  });
});

describe("parseNonNegativeInteger", () => {
  test("accepts non-negative integers including 0 and large values", () => {
    expect(parseNonNegativeInteger("0", "AGENTS_JS_SYNC_INTERVAL_MS")).toBe(0);
    expect(parseNonNegativeInteger("300000", "AGENTS_JS_SYNC_INTERVAL_MS")).toBe(300_000);
    expect(parseNonNegativeInteger("  60000  ", "AGENTS_JS_SYNC_INTERVAL_MS")).toBe(60_000);
  });

  test("rejects the Number()-permissive values the old call site accepted", () => {
    // `Number("abc")` is NaN, `Number("Infinity")` is Infinity, `Number("1e6")`
    // is 1_000_000 — all would have flowed into the registry-sync timer.
    for (const bad of ["abc", "Infinity", "NaN", "1e6", "3.14", "-1", "+5", "0x10", "", "   "]) {
      expect(() => parseNonNegativeInteger(bad, "AGENTS_JS_SYNC_INTERVAL_MS")).toThrow();
    }
  });

  test("rejects values beyond the safe-integer range", () => {
    expect(() => parseNonNegativeInteger("99999999999999999999", "label")).toThrow();
  });

  test("error message surfaces the label and the custom hint", () => {
    expect(() => parseNonNegativeInteger("nope", "--interval", "an integer >= 0")).toThrow(
      'Invalid --interval "nope". Expected an integer >= 0.',
    );
  });
});

describe("resolveGatewayPort", () => {
  test("uses cli override first", () => {
    expect(resolveGatewayPort({ cliPort: 61001, envPort: "62001", configPort: 63001 })).toBe(61001);
  });

  test("falls back from env to config to dynamic default", () => {
    expect(resolveGatewayPort({ envPort: "62001", configPort: 63001 })).toBe(62001);
    expect(resolveGatewayPort({ configPort: 63001 })).toBe(63001);
    expect(resolveGatewayPort({})).toBe(0);
  });
});

describe("gateway discovery formatting", () => {
  test("prints explicit HTTP and WS URLs without adjacency assumptions", () => {
    const discovery = buildGatewayDiscovery(61001, 62002);

    expect(discovery.gatewayUrl).toBe("http://127.0.0.1:61001");
    expect(discovery.gatewayWsUrl).toBe("ws://127.0.0.1:62002");
    expect(discovery.gatewayCardUrl).toBe("http://127.0.0.1:61001/.well-known/agent-card.json");
    expect(formatGatewayDiscoveryLines(discovery)).toEqual([
      "[Gateway] Gateway URL: http://127.0.0.1:61001",
      "[Gateway] Gateway WS URL: ws://127.0.0.1:62002",
    ]);
  });
});

describe("resolveGatewayPublicUrl", () => {
  test("uses explicit public URL before bind hostname", () => {
    expect(
      resolveGatewayPublicUrl({
        publicUrl: "http://agents-gateway.q4m.dev:9321",
        port: 9321,
        hostname: "0.0.0.0",
      }),
    ).toBe("http://agents-gateway.q4m.dev:9321/");
  });

  test("falls back to bind-derived URL when no explicit public URL is set", () => {
    expect(resolveGatewayPublicUrl({ port: 9321, hostname: "0.0.0.0" })).toBe(
      "http://127.0.0.1:9321",
    );
    expect(resolveGatewayPublicUrl({ port: 9321, hostname: "10.0.1.192" })).toBe(
      "http://10.0.1.192:9321",
    );
  });
});
