import { describe, expect, test } from "bun:test";
import { parseAgentIdentity } from "../src/identity-scheme.ts";
import { type AgentLaunchProfile, deriveLaunchProfile } from "../src/launch-profile.ts";

function profile(name: string, gatewayHost = "lxc189", gatewayPort?: number): AgentLaunchProfile {
  const id = parseAgentIdentity(name);
  if (!id) throw new Error(`fixture name did not parse: ${name}`);
  return deriveLaunchProfile(id, { gatewayHost, gatewayPort });
}

describe("deriveLaunchProfile — native (malar-pi-0 shape)", () => {
  test("native pi runs the pi binary on the operator host with ZAI_API_KEY", () => {
    const p = profile("malar-pi-0");
    expect(p.launchMode).toBe("native");
    expect(p.runtimeHost).toBe("malar"); // operator host, NOT gateway
    expect(p.providerEnvVar).toBe("ZAI_API_KEY"); // Pi native Zai, no LiteLLM
    expect(p.commandSpec.command).toBe("pi");
    expect(p.commandSpec.args).toEqual([]);
  });

  test("native claude has no provider env var (own credential flow)", () => {
    const p = profile("olthoi0-claude-0");
    expect(p.launchMode).toBe("native");
    expect(p.runtimeHost).toBe("olthoi0");
    expect(p.providerEnvVar).toBeUndefined();
    expect(p.commandSpec.command).toBe("claude");
  });
});

describe("deriveLaunchProfile — ajs-fronted (malar-ajs-pi-0 shape)", () => {
  test("ajs-fronted pi runs the gateway with --runtime pi on the gateway host", () => {
    const p = profile("malar-ajs-pi-0", "lxc189");
    expect(p.launchMode).toBe("ajs-fronted");
    expect(p.runtimeHost).toBe("lxc189"); // gateway host, NOT malar
    expect(p.providerEnvVar).toBe("ZAI_API_KEY"); // gateway-spawned pi still reads it
    expect(p.commandSpec.command).toBe("agents-js-gateway");
    expect(p.commandSpec.args).toEqual(["--runtime", "pi"]);
  });

  test("gateway port appended when provided", () => {
    const p = profile("malar-ajs-pi-0", "lxc189", 9300);
    expect(p.commandSpec.args).toEqual(["--runtime", "pi", "--port", "9300"]);
  });

  test("ajs-fronted claude → gateway --runtime claude", () => {
    const p = profile("olthoi0-ajs-claude-0", "lxc189");
    expect(p.launchMode).toBe("ajs-fronted");
    expect(p.runtimeHost).toBe("lxc189");
    expect(p.commandSpec.command).toBe("agents-js-gateway");
    expect(p.commandSpec.args).toEqual(["--runtime", "claude"]);
  });
});

describe("deriveLaunchProfile — the two malar profiles are distinct", () => {
  test("malar-pi-0 vs malar-ajs-pi-0 differ in mode, runtimeHost, and command", () => {
    const native = profile("malar-pi-0", "lxc189");
    const fronted = profile("malar-ajs-pi-0", "lxc189");
    expect(native.launchMode).not.toBe(fronted.launchMode);
    expect(native.runtimeHost).not.toBe(fronted.runtimeHost);
    expect(native.commandSpec.command).not.toBe(fronted.commandSpec.command);
    // both are the pi harness, both read ZAI_API_KEY — same agent family, distinct profiles
    expect(native.identity.harness).toBe("pi");
    expect(fronted.identity.harness).toBe("pi");
    expect(native.providerEnvVar).toBe(fronted.providerEnvVar);
  });
});
