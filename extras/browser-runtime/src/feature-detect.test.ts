import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type BrowserCapabilities, detectBrowserCapabilities } from "./feature-detect.ts";

interface TestGlobals {
  navigator?: { gpu?: unknown; deviceMemory?: number };
  isSecureContext?: boolean;
}

const stash: TestGlobals = {};

beforeEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
  stash.navigator = (globalThis as any).navigator;
  // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
  stash.isSecureContext = (globalThis as any).isSecureContext;
});

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
  (globalThis as any).navigator = stash.navigator;
  // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
  (globalThis as any).isSecureContext = stash.isSecureContext;
});

describe("detectBrowserCapabilities", () => {
  it("returns webgpu=false when navigator.gpu is missing", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).navigator = {};
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).isSecureContext = true;
    const caps = await detectBrowserCapabilities();
    expect(caps.webgpu).toBe(false);
    expect(caps.adapterFeatures).toEqual([]);
  });

  it("returns webgpu=false when not in a secure context", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).navigator = {
      gpu: { requestAdapter: async () => ({ features: new Set() }) },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).isSecureContext = false;
    const caps = await detectBrowserCapabilities();
    expect(caps.webgpu).toBe(false);
    expect(caps.secureContext).toBe(false);
  });

  it("returns webgpu=true and reports adapter features when available", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).navigator = {
      gpu: {
        requestAdapter: async () => ({ features: new Set(["shader-f16", "timestamp-query"]) }),
      },
      deviceMemory: 16,
    };
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).isSecureContext = true;
    const caps = await detectBrowserCapabilities();
    expect(caps.webgpu).toBe(true);
    expect(caps.adapterFeatures).toContain("shader-f16");
    expect(caps.deviceMemoryGB).toBe(16);
  });

  it("clamps deviceMemory to 8 when undefined", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).navigator = {
      gpu: { requestAdapter: async () => ({ features: new Set() }) },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).isSecureContext = true;
    const caps: BrowserCapabilities = await detectBrowserCapabilities();
    expect(caps.deviceMemoryGB).toBe(8);
  });

  it("handles requestAdapter rejection (no compatible adapter)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).navigator = {
      gpu: { requestAdapter: async () => null },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).isSecureContext = true;
    const caps = await detectBrowserCapabilities();
    expect(caps.webgpu).toBe(false);
    expect(caps.adapterFeatures).toEqual([]);
  });

  it("handles requestAdapter throwing (GPU process crash / browser bug)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).navigator = {
      gpu: {
        requestAdapter: async () => {
          throw new Error("GPU process crashed");
        },
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test stubs globalThis to simulate browser env
    (globalThis as any).isSecureContext = true;
    const caps = await detectBrowserCapabilities();
    expect(caps.webgpu).toBe(false);
    expect(caps.adapterFeatures).toEqual([]);
  });
});
