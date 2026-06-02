import { describe, expect, test } from "bun:test";
import { parseAgentIdentity } from "../src/identity-scheme.ts";
import { deriveChannelEnv, deriveRegistryEntry } from "../src/launch-profile.ts";

const idOf = (name: string) => {
  const id = parseAgentIdentity(name);
  if (!id) throw new Error(`fixture did not parse: ${name}`);
  return id;
};

describe("deriveChannelEnv", () => {
  test("generates CH_GATEWAY_* from the identity + supplied gateway/key cmd", () => {
    const keyCmd = "fetch-identity-key malar-ajs-pi-0"; // caller-supplied; convention lives in the fleet pkg
    const env = deriveChannelEnv(idOf("malar-ajs-pi-0"), {
      gatewayUrl: "https://gateway.example/",
      keyCmd,
    });
    expect(env.CH_GATEWAY_IDENTITY).toBe("malar-ajs-pi-0"); // derived from the name
    expect(env.CH_GATEWAY_URL).toBe("https://gateway.example/");
    expect(env.CH_GATEWAY_KEY_CMD).toBe(keyCmd);
    expect("CH_LOG" in env).toBe(false); // omitted unless logPath provided
  });

  test("includes CH_LOG when logPath given", () => {
    const env = deriveChannelEnv(idOf("olthoi0-ajs-claude-0"), {
      gatewayUrl: "https://gw.example",
      keyCmd: "fetch-key",
      logPath: "/var/log/ch.log",
    });
    expect(env.CH_LOG).toBe("/var/log/ch.log");
    expect(env.CH_GATEWAY_IDENTITY).toBe("olthoi0-ajs-claude-0");
  });

  test("frozen result", () => {
    const env = deriveChannelEnv(idOf("malar-pi-0"), { gatewayUrl: "u", keyCmd: "k" });
    expect(Object.isFrozen(env)).toBe(true);
  });
});

describe("deriveRegistryEntry", () => {
  test("native A2A registry entry shape", () => {
    const entry = deriveRegistryEntry(idOf("malar-pi-0"), { url: "http://127.0.0.1:9000" });
    expect(entry).toEqual({ kind: "a2a", name: "malar-pi-0", url: "http://127.0.0.1:9000" });
  });

  test("name is the full identity name", () => {
    const entry = deriveRegistryEntry(idOf("hostname-null-pi-1"), { url: "http://h:1" });
    expect(entry.name).toBe("hostname-null-pi-1");
    expect(entry.kind).toBe("a2a");
  });
});
