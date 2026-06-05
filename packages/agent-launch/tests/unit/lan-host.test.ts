import { describe, expect, test } from "bun:test";
import { detectLanHost, type NetworkInterfacesSource } from "../../src/lan-host.ts";

const source =
  (
    ifaces: Record<string, Array<{ address: string; family: string | number; internal: boolean }>>,
  ): NetworkInterfacesSource =>
  () =>
    ifaces;

describe("detectLanHost", () => {
  test("returns the first non-internal IPv4 address", () => {
    const detected = detectLanHost(
      source({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        en0: [{ address: "10.0.0.223", family: "IPv4", internal: false }],
      }),
    );
    expect(detected).toBe("10.0.0.223");
  });

  test("skips loopback and IPv6, picks the external IPv4", () => {
    const detected = detectLanHost(
      source({
        lo0: [{ address: "::1", family: "IPv6", internal: true }],
        en0: [
          { address: "fe80::1", family: "IPv6", internal: false },
          { address: "192.168.1.42", family: "IPv4", internal: false },
        ],
      }),
    );
    expect(detected).toBe("192.168.1.42");
  });

  test("accepts the numeric family form (4) some runtimes report", () => {
    const detected = detectLanHost(
      source({ en0: [{ address: "10.1.2.3", family: 4, internal: false }] }),
    );
    expect(detected).toBe("10.1.2.3");
  });

  test("returns undefined when only loopback exists (isolated host)", () => {
    const detected = detectLanHost(
      source({ lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }),
    );
    expect(detected).toBeUndefined();
  });

  test("returns undefined when there are no interfaces", () => {
    expect(detectLanHost(source({}))).toBeUndefined();
  });
});
