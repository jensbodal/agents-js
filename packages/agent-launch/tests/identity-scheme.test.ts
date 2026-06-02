import { describe, expect, test } from "bun:test";
import {
  type AgentIdentity,
  deriveRuntimeHost,
  parseAgentIdentity,
} from "../src/identity-scheme.ts";

describe("parseAgentIdentity — ajs-fronted", () => {
  test("olthoi0-ajs-claude-0 → operatorHost olthoi0, fronted, claude, 0", () => {
    const id = parseAgentIdentity("olthoi0-ajs-claude-0");
    expect(id).not.toBeNull();
    const v = id as AgentIdentity;
    expect(v.operatorHost).toBe("olthoi0");
    expect(v.ajsFronted).toBe(true);
    expect(v.harness).toBe("claude");
    expect(v.harnessKind).toBe("claude-code");
    expect(v.index).toBe(0);
  });

  test("malar-ajs-pi-0 → malar, fronted, pi", () => {
    const v = parseAgentIdentity("malar-ajs-pi-0") as AgentIdentity;
    expect(v.operatorHost).toBe("malar");
    expect(v.ajsFronted).toBe(true);
    expect(v.harness).toBe("pi");
    expect(v.harnessKind).toBe("pi");
    expect(v.index).toBe(0);
  });

  test("multi-segment operator host: hostname-null-ajs-claude-2", () => {
    const v = parseAgentIdentity("hostname-null-ajs-claude-2") as AgentIdentity;
    expect(v.operatorHost).toBe("hostname-null");
    expect(v.ajsFronted).toBe(true);
    expect(v.harness).toBe("claude");
    expect(v.index).toBe(2);
  });
});

describe("parseAgentIdentity — native", () => {
  test("olthoi0-claude-0 → native, not fronted", () => {
    const v = parseAgentIdentity("olthoi0-claude-0") as AgentIdentity;
    expect(v.operatorHost).toBe("olthoi0");
    expect(v.ajsFronted).toBe(false);
    expect(v.harness).toBe("claude");
    expect(v.index).toBe(0);
  });

  test("multi-segment host stays native: hostname-null-pi-1", () => {
    const v = parseAgentIdentity("hostname-null-pi-1") as AgentIdentity;
    expect(v.operatorHost).toBe("hostname-null");
    expect(v.ajsFronted).toBe(false);
    expect(v.harness).toBe("pi");
    expect(v.index).toBe(1);
  });
});

describe("parseAgentIdentity — legacy/non-matching returns null", () => {
  test.each([
    "cognee-claude", // legacy free-form, no index
    "agent-zero-dev", // legacy, "dev" not a known harness, no numeric index
    "mcp-opencode", // no index
    "claude-0", // no operator host before harness
    "olthoi0-ajs-claude", // missing index
    "olthoi0-frobnicate-0", // unknown harness token
    "olthoi0-claude-x", // non-numeric index
    "ajs-claude-0", // `ajs` marker with no operator host before it → ambiguous, reject
    "", // empty
    "olthoi0", // single segment
  ])("%s → null", (name) => {
    expect(parseAgentIdentity(name)).toBeNull();
  });
});

describe("deriveRuntimeHost", () => {
  test("ajs-fronted → gateway host", () => {
    const id = parseAgentIdentity("olthoi0-ajs-claude-0") as AgentIdentity;
    expect(deriveRuntimeHost(id, "lxc189")).toBe("lxc189");
  });

  test("native → operator host (gateway host ignored)", () => {
    const id = parseAgentIdentity("olthoi0-claude-0") as AgentIdentity;
    expect(deriveRuntimeHost(id, "lxc189")).toBe("olthoi0");
  });
});
