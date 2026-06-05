/**
 * LAN-host detection — the impure boundary that keeps {@link buildLaunchPlan}
 * pure. A native agent that only ever advertises `127.0.0.1` is unreachable
 * from other machines on the LAN; onboarding an agent onto a multi-machine mesh
 * needs it to advertise a routable address. This helper reads the host's
 * network interfaces (the impurity the planner forbids) and returns the primary
 * non-loopback IPv4, which the CLI injects into `buildLaunchPlan` as
 * `resolveLanHost`.
 *
 * Returns `undefined` when no external IPv4 interface exists (an isolated or
 * loopback-only host), letting callers fall back to the localhost default
 * rather than advertising an unreachable address.
 */

import { networkInterfaces as osNetworkInterfaces } from "node:os";

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
