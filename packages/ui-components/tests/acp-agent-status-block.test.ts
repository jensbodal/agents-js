import { describe, expect, test } from "bun:test";
import { AcpAgentStatusBlock, registerAllComponents } from "../src/index.ts";

describe("AcpAgentStatusBlock", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpAgentStatusBlock).toBe("function");
  });

  test("has expected static styles (theme + component)", () => {
    expect(AcpAgentStatusBlock.styles).toBeDefined();
    expect(Array.isArray(AcpAgentStatusBlock.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("exposes reactive `agent` + threshold properties", () => {
    const props = AcpAgentStatusBlock.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("agent")).toBeDefined();
    expect(props.get("activeThresholdSeconds")).toBeDefined();
    expect(props.get("staleThresholdSeconds")).toBeDefined();
  });

  test("`agent` property is non-attribute (object payload, not string)", () => {
    const agentProp = AcpAgentStatusBlock.elementProperties.get("agent");
    expect(agentProp?.attribute).toBe(false);
  });

  test("threshold properties are typed Number", () => {
    const activeT = AcpAgentStatusBlock.elementProperties.get("activeThresholdSeconds");
    const staleT = AcpAgentStatusBlock.elementProperties.get("staleThresholdSeconds");
    expect(activeT?.type).toBe(Number);
    expect(staleT?.type).toBe(Number);
  });
});
