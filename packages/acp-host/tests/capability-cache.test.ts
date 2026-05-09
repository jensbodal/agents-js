import { describe, expect, test } from "bun:test";
import { CapabilityCache } from "../src/capability-cache.ts";

describe("CapabilityCache", () => {
  test("returns false for agent capabilities when no data provided", () => {
    const cache = new CapabilityCache();
    expect(cache.supportsLoadSession()).toBe(false);
    expect(cache.supportsListSessions()).toBe(false);
    expect(cache.supportsMcp()).toBe(false);
    expect(cache.supportsEmbeddedContext()).toBe(false);
    expect(cache.raw).toBeNull();
  });

  test("client advertised capabilities default to true", () => {
    const cache = new CapabilityCache();
    expect(cache.supportsTerminal()).toBe(true);
    expect(cache.supportsFileRead()).toBe(true);
    expect(cache.supportsFileWrite()).toBe(true);
  });

  test("client advertised capabilities can be disabled", () => {
    const cache = new CapabilityCache();
    cache.advertisedTerminal = false;
    cache.advertisedFileRead = false;
    cache.advertisedFileWrite = false;
    expect(cache.supportsTerminal()).toBe(false);
    expect(cache.supportsFileRead()).toBe(false);
    expect(cache.supportsFileWrite()).toBe(false);
  });

  test("parses loadSession capability", () => {
    const cache = new CapabilityCache();
    cache.update({ loadSession: true });
    expect(cache.supportsLoadSession()).toBe(true);
  });

  test("parses sessionCapabilities.list (presence-based)", () => {
    const cache = new CapabilityCache();
    cache.update({
      sessionCapabilities: { list: {} },
    });
    expect(cache.supportsListSessions()).toBe(true);
  });

  test("parses mcpCapabilities", () => {
    const cache = new CapabilityCache();
    cache.update({
      mcpCapabilities: {},
    });
    expect(cache.supportsMcp()).toBe(true);
  });

  test("parses promptCapabilities for embeddedContext", () => {
    const cache = new CapabilityCache();
    cache.update({
      promptCapabilities: {
        embeddedContext: true,
      },
    });
    expect(cache.supportsEmbeddedContext()).toBe(true);
  });

  test("returns false for embeddedContext when not set", () => {
    const cache = new CapabilityCache();
    cache.update({
      promptCapabilities: {},
    });
    expect(cache.supportsEmbeddedContext()).toBe(false);
  });

  test("clear resets to null", () => {
    const cache = new CapabilityCache();
    cache.update({ loadSession: true });
    expect(cache.supportsLoadSession()).toBe(true);
    cache.clear();
    expect(cache.supportsLoadSession()).toBe(false);
    expect(cache.raw).toBeNull();
  });

  test("handles null/undefined input", () => {
    const cache = new CapabilityCache();
    cache.update(null);
    expect(cache.raw).toBeNull();
    cache.update(undefined);
    expect(cache.raw).toBeNull();
  });

  test("agent capabilities are independent of client capabilities", () => {
    const cache = new CapabilityCache();
    cache.update({
      loadSession: true,
      sessionCapabilities: { list: {} },
    });
    expect(cache.supportsLoadSession()).toBe(true);
    expect(cache.supportsListSessions()).toBe(true);
    expect(cache.supportsTerminal()).toBe(true);
    expect(cache.supportsFileRead()).toBe(true);
  });

  test("setMcpServerAvailable updates workspace capability flags", () => {
    const cache = new CapabilityCache();
    expect(cache.advertisedWorkspaceSearch).toBe(false);
    expect(cache.advertisedOptionalExtension).toBe(false);

    cache.setMcpServerAvailable(true, true);
    expect(cache.advertisedWorkspaceSearch).toBe(true);
    expect(cache.advertisedCommandExecution).toBe(true);
    expect(cache.advertisedNavigation).toBe(true);
    expect(cache.advertisedOptionalExtension).toBe(true);

    cache.setMcpServerAvailable(true, false);
    expect(cache.advertisedOptionalExtension).toBe(false);
    expect(cache.advertisedWorkspaceSearch).toBe(true);

    cache.setMcpServerAvailable(false, true);
    expect(cache.advertisedWorkspaceSearch).toBe(false);
    expect(cache.advertisedOptionalExtension).toBe(false);
  });

  test("supportsCloseSession returns true when advertised", () => {
    const cache = new CapabilityCache();
    expect(cache.supportsCloseSession()).toBe(false);

    cache.update({
      sessionCapabilities: { close: {} },
    });
    expect(cache.supportsCloseSession()).toBe(true);
  });

  test("supportsCloseSession returns false when not advertised", () => {
    const cache = new CapabilityCache();
    cache.update({
      sessionCapabilities: { list: {} },
    });
    expect(cache.supportsCloseSession()).toBe(false);
  });

  test("supportsForkSession returns true when advertised", () => {
    const cache = new CapabilityCache();
    expect(cache.supportsForkSession()).toBe(false);

    cache.update({
      sessionCapabilities: { fork: {} },
    });
    expect(cache.supportsForkSession()).toBe(true);
  });

  test("supportsForkSession returns false when not advertised", () => {
    const cache = new CapabilityCache();
    cache.update({
      sessionCapabilities: { list: {} },
    });
    expect(cache.supportsForkSession()).toBe(false);
  });

  test("supportsResumeSession returns true when advertised", () => {
    const cache = new CapabilityCache();
    expect(cache.supportsResumeSession()).toBe(false);

    cache.update({
      sessionCapabilities: { resume: {} },
    });
    expect(cache.supportsResumeSession()).toBe(true);
  });

  test("supportsResumeSession returns false when not advertised", () => {
    const cache = new CapabilityCache();
    cache.update({
      sessionCapabilities: { list: {} },
    });
    expect(cache.supportsResumeSession()).toBe(false);
  });

  test("clear resets session lifecycle capability checks", () => {
    const cache = new CapabilityCache();
    cache.update({
      sessionCapabilities: { close: {}, fork: {}, resume: {} },
    });
    expect(cache.supportsCloseSession()).toBe(true);
    expect(cache.supportsForkSession()).toBe(true);
    expect(cache.supportsResumeSession()).toBe(true);

    cache.clear();
    expect(cache.supportsCloseSession()).toBe(false);
    expect(cache.supportsForkSession()).toBe(false);
    expect(cache.supportsResumeSession()).toBe(false);
  });

  test("supportsLogout returns true when auth.logout is advertised", () => {
    const cache = new CapabilityCache();
    expect(cache.supportsLogout()).toBe(false);

    cache.update({
      auth: { logout: {} },
    });
    expect(cache.supportsLogout()).toBe(true);
  });

  test("supportsLogout returns false when auth has no logout", () => {
    const cache = new CapabilityCache();
    cache.update({
      auth: {},
    });
    expect(cache.supportsLogout()).toBe(false);
  });

  test("supportsLogout returns false when no auth capabilities", () => {
    const cache = new CapabilityCache();
    cache.update({});
    expect(cache.supportsLogout()).toBe(false);
  });

  test("supportsSetConfigOption returns true when sessionCapabilities exists", () => {
    const cache = new CapabilityCache();
    expect(cache.supportsSetConfigOption()).toBe(false);

    cache.update({
      sessionCapabilities: {},
    });
    expect(cache.supportsSetConfigOption()).toBe(true);
  });

  test("clear resets logout and config option capability checks", () => {
    const cache = new CapabilityCache();
    cache.update({
      auth: { logout: {} },
      sessionCapabilities: {},
    });
    expect(cache.supportsLogout()).toBe(true);
    expect(cache.supportsSetConfigOption()).toBe(true);

    cache.clear();
    expect(cache.supportsLogout()).toBe(false);
    expect(cache.supportsSetConfigOption()).toBe(false);
  });
});
