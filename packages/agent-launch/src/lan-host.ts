/**
 * LAN-host detection — the impure boundary that keeps {@link buildLaunchPlan}
 * pure. A native agent that only ever advertises `127.0.0.1` is unreachable
 * from other machines on the LAN; onboarding an agent onto a multi-machine mesh
 * needs it to advertise a routable address. These helpers read the host's
 * network interfaces + hostname (the impurity the planner forbids); the CLI
 * composes them and injects the result into `buildLaunchPlan` as
 * `resolveLanHost`.
 *
 * Two address forms, in preference order:
 *
 *   1. FQDN `<shortHost>.<lanDomain>` — when an operator-configured LAN domain
 *      is supplied. A hostname survives the DHCP lease changes that rotate raw
 *      IPs, so a peer registered as `malar.q4m.dev` stays reachable across
 *      renewals. The LAN domain is never hardcoded — it comes from config/env.
 *   2. Primary non-loopback IPv4 — the fallback when no LAN domain is set.
 *
 * Each resolver returns `undefined` when its inputs are unavailable (isolated or
 * loopback-only host, unset hostname), letting callers fall back to the
 * localhost default rather than advertising an unreachable address.
 */

import { hostname as osHostname, networkInterfaces as osNetworkInterfaces } from "node:os";

/** Minimal shape of a `node:os` interface address — kept local so the detector
 * can be unit-tested with an injected interfaces source. */
export interface InterfaceAddressInfo {
  readonly address: string;
  readonly family: string | number;
  readonly internal: boolean;
}

export type NetworkInterfacesSource = () => Record<
  string,
  readonly InterfaceAddressInfo[] | undefined
>;

/**
 * Pick the host's primary LAN-reachable IPv4 address (first non-internal IPv4),
 * or `undefined` when none exists. `source` is injectable for deterministic
 * tests; production callers use the default `node:os` reader.
 */
export function detectLanHost(
  source: NetworkInterfacesSource = osNetworkInterfaces,
): string | undefined {
  for (const addrs of Object.values(source())) {
    for (const addr of addrs ?? []) {
      // node:os reports family as "IPv4" (string) on modern runtimes and `4`
      // (number) on some older/bun builds — accept both.
      const isIpv4 = addr.family === "IPv4" || addr.family === 4;
      if (isIpv4 && !addr.internal) return addr.address;
    }
  }
  return undefined;
}

/** Source of the host's name — injectable for deterministic tests. */
export type HostnameSource = () => string | undefined;

/**
 * The host's short name: the first DNS label of `os.hostname()`. The runtime is
 * platform-inconsistent — macOS reports the mDNS form `malar.local`, Linux
 * reports bare `malar`, some hosts report a full FQDN — so taking the first
 * label normalizes all three to `malar`. That keeps `<shortHost>.<lanDomain>`
 * from doubling a suffix (never `malar.local.q4m.dev`). Returns `undefined` for
 * an empty/unset hostname.
 */
export function detectHostname(source: HostnameSource = osHostname): string | undefined {
  const short = source()?.trim().split(".")[0];
  return short && short.length > 0 ? short : undefined;
}

/**
 * Resolve the address a native peer advertises on the LAN, preferring a stable
 * FQDN over a raw IP. When `lanDomain` is configured AND the short hostname is
 * detectable, advertise `<shortHost>.<lanDomain>`; otherwise fall back to the
 * primary non-loopback IPv4, then `undefined` (loopback default). `lanDomain` is
 * operator-supplied (config field / env) — there is no hardcoded default domain.
 */
export function resolveLanAdvertiseHost(
  opts: {
    readonly lanDomain?: string;
    readonly hostnameSource?: HostnameSource;
    readonly interfacesSource?: NetworkInterfacesSource;
  } = {},
): string | undefined {
  const lanDomain = opts.lanDomain?.trim();
  if (lanDomain) {
    const host = detectHostname(opts.hostnameSource);
    if (host) return `${host}.${lanDomain}`;
  }
  return detectLanHost(opts.interfacesSource);
}
