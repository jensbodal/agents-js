/**
 * Unit tests for resolveRemoteGatewayEnv — the gateway's hostname-mode
 * discriminator and coordinator-URL contract.
 *
 * The parser sits at the boundary between raw process env and runtime
 * configuration: it must (a) default to the back-compat "resolvable" mode
 * when nothing is set, (b) demand a usable coordinator URL whenever the
 * gateway opts into "null" hostname mode, and (c) refuse any unknown mode
 * value loudly so a typo never silently degrades to default behavior.
 */

import { describe, expect, test } from "bun:test";
import { resolveRemoteGatewayEnv } from "../src/remote-gateway-env.ts";

describe("resolveRemoteGatewayEnv — hostname-mode discrimination", () => {
  // Back-compat: existing gateways have never set this var and must keep
  // advertising a resolvable hostname. Default must be "resolvable".
  test("defaults hostnameMode to 'resolvable' when env unset", () => {
    const cfg = resolveRemoteGatewayEnv({});
    expect(cfg.hostnameMode).toBe("resolvable");
    expect(cfg.coordinatorUrl).toBeUndefined();
  });

  // Explicit "resolvable" is the same as unset; no coordinator URL is needed
  // and none should be reported. Locks in symmetry between unset and explicit.
  test("accepts hostnameMode='resolvable' explicitly with no coordinator URL", () => {
    const cfg = resolveRemoteGatewayEnv({
      AJS_GATEWAY_HOSTNAME_MODE: "resolvable",
    });
    expect(cfg.hostnameMode).toBe("resolvable");
    expect(cfg.coordinatorUrl).toBeUndefined();
  });

  // The primary happy-path for the federation spec: a gateway with no
  // resolvable hostname publishes itself via an https coordinator endpoint.
  test("accepts hostnameMode='null' with valid https coordinator URL", () => {
    const cfg = resolveRemoteGatewayEnv({
      AJS_GATEWAY_HOSTNAME_MODE: "null",
      AJS_GATEWAY_COORDINATOR_URL: "https://coord.example.com/registry",
    });
    expect(cfg.hostnameMode).toBe("null");
    expect(cfg.coordinatorUrl).toBe("https://coord.example.com/registry");
  });

  // http is permitted (local dev, internal networks) — parser must not
  // hard-require TLS at this layer; that's a deployment policy concern.
  test("accepts hostnameMode='null' with valid http coordinator URL", () => {
    const cfg = resolveRemoteGatewayEnv({
      AJS_GATEWAY_HOSTNAME_MODE: "null",
      AJS_GATEWAY_COORDINATOR_URL: "http://localhost:4000/registry",
    });
    expect(cfg.hostnameMode).toBe("null");
    expect(cfg.coordinatorUrl).toBe("http://localhost:4000/registry");
  });
});

describe("resolveRemoteGatewayEnv — validation errors", () => {
  // Mode=null without a coordinator URL leaves the gateway un-discoverable;
  // we must fail fast rather than start a useless process.
  test("rejects hostnameMode='null' with missing coordinator URL", () => {
    expect(() => resolveRemoteGatewayEnv({ AJS_GATEWAY_HOSTNAME_MODE: "null" })).toThrow(
      /AJS_GATEWAY_COORDINATOR_URL/,
    );
  });

  // Empty string is a common shell-eval foot-gun (`export FOO=`) and must
  // be treated the same as missing — not as "URL is the empty string".
  test("rejects hostnameMode='null' with empty coordinator URL", () => {
    expect(() =>
      resolveRemoteGatewayEnv({
        AJS_GATEWAY_HOSTNAME_MODE: "null",
        AJS_GATEWAY_COORDINATOR_URL: "",
      }),
    ).toThrow(/AJS_GATEWAY_COORDINATOR_URL/);
  });

  // Non-http(s) protocols (ftp, file, ws, custom schemes) parse as URLs but
  // cannot be used as a registry endpoint; reject at parse time.
  test("rejects hostnameMode='null' with non-http(s) coordinator URL (e.g. ftp://)", () => {
    expect(() =>
      resolveRemoteGatewayEnv({
        AJS_GATEWAY_HOSTNAME_MODE: "null",
        AJS_GATEWAY_COORDINATOR_URL: "ftp://coord.example.com/registry",
      }),
    ).toThrow(/http/);
  });

  // Garbage strings that don't parse as URLs at all — surface the WHATWG
  // URL constructor failure as a clear EnvError, not a raw TypeError.
  test("rejects hostnameMode='null' with malformed coordinator URL", () => {
    expect(() =>
      resolveRemoteGatewayEnv({
        AJS_GATEWAY_HOSTNAME_MODE: "null",
        AJS_GATEWAY_COORDINATOR_URL: "not a url at all",
      }),
    ).toThrow(/AJS_GATEWAY_COORDINATOR_URL/);
  });

  // Typos must not silently degrade to "resolvable" (data loss) nor to
  // "null" (broken discovery). Enumerate-and-reject is the only safe path.
  test("rejects unknown hostnameMode values (e.g. 'maybe', '', '1')", () => {
    for (const bad of ["maybe", "", "1", "Null", "RESOLVABLE", "true"]) {
      expect(() => resolveRemoteGatewayEnv({ AJS_GATEWAY_HOSTNAME_MODE: bad })).toThrow(
        /AJS_GATEWAY_HOSTNAME_MODE/,
      );
    }
  });
});

describe("resolveRemoteGatewayEnv — coordinator URL is ignored when mode=resolvable", () => {
  // The coordinator URL is only meaningful in null mode. Surfacing a value
  // in resolvable mode would invite callers to act on it; suppress it so
  // the discriminated-union shape stays honest.
  test("returns coordinatorUrl=undefined when mode=resolvable even if AJS_GATEWAY_COORDINATOR_URL is set", () => {
    const cfg = resolveRemoteGatewayEnv({
      AJS_GATEWAY_HOSTNAME_MODE: "resolvable",
      AJS_GATEWAY_COORDINATOR_URL: "https://coord.example.com/registry",
    });
    expect(cfg.hostnameMode).toBe("resolvable");
    expect(cfg.coordinatorUrl).toBeUndefined();
  });
});
