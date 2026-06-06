import { describe, expect, test } from "bun:test";
import {
  detectHostname,
  detectLanHost,
  type HostnameSource,
  type NetworkInterfacesSource,
  resolveLanAdvertiseHost,
} from "../../src/lan-host.ts";

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

const host =
  (name: string | undefined): HostnameSource =>
  () =>
    name;

describe("detectHostname", () => {
  test("strips the mDNS .local suffix macOS reports (malar.local → malar)", () => {
    expect(detectHostname(host("malar.local"))).toBe("malar");
  });

  test("passes through a bare Linux hostname (malar → malar)", () => {
    expect(detectHostname(host("malar"))).toBe("malar");
  });

  test("takes the first label of a full FQDN (malar.corp.example.com → malar)", () => {
    expect(detectHostname(host("malar.corp.example.com"))).toBe("malar");
  });

  test("trims surrounding whitespace before taking the first label", () => {
    expect(detectHostname(host("  malar.local  "))).toBe("malar");
  });

  test("returns undefined for an empty or whitespace-only hostname", () => {
    expect(detectHostname(host(""))).toBeUndefined();
    expect(detectHostname(host("   "))).toBeUndefined();
    expect(detectHostname(host(undefined))).toBeUndefined();
  });
});

describe("resolveLanAdvertiseHost", () => {
  const ifaces = source({
    en0: [{ address: "10.0.0.223", family: "IPv4", internal: false }],
  });

  test("composes <shortHost>.<lanDomain> when a LAN domain is configured", () => {
    const advertised = resolveLanAdvertiseHost({
      lanDomain: "q4m.dev",
      hostnameSource: host("malar.local"),
      interfacesSource: ifaces,
    });
    expect(advertised).toBe("malar.q4m.dev");
  });

  test("never doubles a suffix — malar.local + q4m.dev → malar.q4m.dev", () => {
    // The hostname carries its own `.local`; composition must use the short
    // label only, otherwise the FQDN would be malar.local.q4m.dev.
    const advertised = resolveLanAdvertiseHost({
      lanDomain: "q4m.dev",
      hostnameSource: host("malar.local"),
      interfacesSource: ifaces,
    });
    expect(advertised).not.toContain(".local.");
    expect(advertised).toBe("malar.q4m.dev");
  });

  test("falls back to the LAN IP when a domain is set but the hostname is unknown", () => {
    const advertised = resolveLanAdvertiseHost({
      lanDomain: "q4m.dev",
      hostnameSource: host(undefined),
      interfacesSource: ifaces,
    });
    expect(advertised).toBe("10.0.0.223");
  });

  test("uses the LAN IP when no LAN domain is configured", () => {
    const advertised = resolveLanAdvertiseHost({
      hostnameSource: host("malar.local"),
      interfacesSource: ifaces,
    });
    expect(advertised).toBe("10.0.0.223");
  });

  test("treats a whitespace-only LAN domain as unset (falls back to IP)", () => {
    const advertised = resolveLanAdvertiseHost({
      lanDomain: "   ",
      hostnameSource: host("malar.local"),
      interfacesSource: ifaces,
    });
    expect(advertised).toBe("10.0.0.223");
  });

  test("returns undefined on an isolated host with no domain and no external IPv4", () => {
    const advertised = resolveLanAdvertiseHost({
      hostnameSource: host("malar.local"),
      interfacesSource: source({
        lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      }),
    });
    expect(advertised).toBeUndefined();
  });
});
