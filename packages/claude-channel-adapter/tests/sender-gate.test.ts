import { describe, expect, test } from "bun:test";
import { createSenderGate } from "../src/sender-gate.ts";

describe("createSenderGate", () => {
  test("deny-unknown when no config is supplied (deny-closed default)", () => {
    const gate = createSenderGate();
    expect(gate.allow("@ajs-claude:matrix")).toBe(false);
    expect(gate.allow("anyone")).toBe(false);
  });

  test("static allowlist allows listed senders + denies others", () => {
    const gate = createSenderGate({
      allowedSenders: ["@ajs-claude:matrix", "@cognee-claude:matrix"],
    });
    expect(gate.allow("@ajs-claude:matrix")).toBe(true);
    expect(gate.allow("@cognee-claude:matrix")).toBe(true);
    expect(gate.allow("@stranger:matrix")).toBe(false);
  });

  test("dynamic callback allows when static allowlist misses", () => {
    const gate = createSenderGate({
      allowedSenders: ["@known:matrix"],
      allow: (sender) => sender.endsWith(":trusted-domain"),
    });
    expect(gate.allow("@known:matrix")).toBe(true);
    expect(gate.allow("@anyone:trusted-domain")).toBe(true);
    expect(gate.allow("@anyone:hostile-domain")).toBe(false);
  });

  test("dynamic callback denies when it returns false", () => {
    const gate = createSenderGate({ allow: () => false });
    expect(gate.allow("@anyone:anywhere")).toBe(false);
  });

  test("dynamic callback that throws collapses to deny (fail-closed)", () => {
    const gate = createSenderGate({
      allow: () => {
        throw new Error("policy backend unreachable");
      },
    });
    expect(gate.allow("@anyone:anywhere")).toBe(false);
  });

  test("dynamic callback that returns a non-boolean truthy value still denies (strict === true)", () => {
    const gate = createSenderGate({
      // biome-ignore lint/suspicious/noExplicitAny: testing non-boolean return
      allow: () => "yes" as any,
    });
    expect(gate.allow("@anyone")).toBe(false);
  });

  test("static allowlist hit short-circuits dynamic callback (fast path)", () => {
    let dynamicCalls = 0;
    const gate = createSenderGate({
      allowedSenders: ["@fastpath:matrix"],
      allow: () => {
        dynamicCalls += 1;
        return true;
      },
    });
    gate.allow("@fastpath:matrix");
    expect(dynamicCalls).toBe(0);
    gate.allow("@dynamic:matrix");
    expect(dynamicCalls).toBe(1);
  });
});
