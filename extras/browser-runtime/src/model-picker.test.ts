import { describe, expect, it } from "bun:test";
import type { BrowserCapabilities } from "./feature-detect.ts";
import {
  chooseModel,
  DEFAULT_SUPPORTED_MODELS,
  type ModelTier,
  SUPPORTED_MODELS,
} from "./model-picker.ts";

const baseCaps: BrowserCapabilities = {
  webgpu: true,
  secureContext: true,
  adapterFeatures: ["shader-f16"],
  deviceMemoryGB: 8,
};

describe("chooseModel", () => {
  it("returns null when WebGPU is unavailable", () => {
    expect(chooseModel({ ...baseCaps, webgpu: false })).toBeNull();
  });

  it("returns null when not in a secure context", () => {
    expect(chooseModel({ ...baseCaps, secureContext: false })).toBeNull();
  });

  it("picks the medium tier on >= 8GB RAM with shader-f16", () => {
    const id = chooseModel(baseCaps);
    expect(id).toBe("Qwen2.5-1.5B-Instruct-q4f16_1-MLC");
  });

  it("picks the small tier on 4-7GB RAM", () => {
    const id = chooseModel({ ...baseCaps, deviceMemoryGB: 4 });
    expect(id).toBe("Llama-3.2-1B-Instruct-q4f16_1-MLC");
  });

  it("picks the fallback tier on <4GB RAM with shader-f16", () => {
    const id = chooseModel({ ...baseCaps, deviceMemoryGB: 2 });
    expect(id).toBe("SmolLM2-360M-Instruct-q4f16_1-MLC");
  });

  it("returns null when low memory and no shader-f16 (no workable tier)", () => {
    expect(chooseModel({ ...baseCaps, deviceMemoryGB: 2, adapterFeatures: [] })).toBeNull();
  });

  it("exposes the SUPPORTED_MODELS list with known ids", () => {
    expect(SUPPORTED_MODELS).toContain("Qwen2.5-1.5B-Instruct-q4f16_1-MLC");
    expect(SUPPORTED_MODELS).toContain("Llama-3.2-1B-Instruct-q4f16_1-MLC");
    expect(SUPPORTED_MODELS).toContain("SmolLM2-360M-Instruct-q4f16_1-MLC");
  });

  it("DEFAULT_SUPPORTED_MODELS lists the same ids in priority order", () => {
    // Pin the default tier list to the legacy flat ids — the override path
    // should be the only way to introduce a new id.
    expect(DEFAULT_SUPPORTED_MODELS.map((tier) => tier.id)).toEqual([...SUPPORTED_MODELS]);
  });

  it("uses a caller-supplied tier list when options.tiers is set", () => {
    // A consumer targeting a Pi fleet might only ship the smallest tier and
    // accept the lower memory threshold. The override should win against the
    // default decision tree — we deliberately use an id NOT in
    // SUPPORTED_MODELS to prove the default list is no longer consulted.
    const tiers: ModelTier[] = [{ id: "Pi-Test-Model-q4f16_1-MLC", minMemoryGB: 1 }];
    const id = chooseModel({ ...baseCaps, deviceMemoryGB: 2 }, { tiers });
    expect(id).toBe("Pi-Test-Model-q4f16_1-MLC");
  });

  it("returns null when no override tier matches the capabilities", () => {
    const tiers: ModelTier[] = [{ id: "Big-Only-q4f16_1-MLC", minMemoryGB: 16 }];
    expect(chooseModel(baseCaps, { tiers })).toBeNull();
  });

  it("respects requiredFeatures in an override tier list", () => {
    // Tier order matters: the higher-memory tier listed first should be
    // skipped because requiredFeatures is missing, falling through to the
    // second tier.
    const tiers: ModelTier[] = [
      {
        id: "Needs-Feature-q4f16_1-MLC",
        minMemoryGB: 0,
        requiredFeatures: ["timestamp-query"],
      },
      { id: "Plain-q4f16_1-MLC", minMemoryGB: 0 },
    ];
    const id = chooseModel({ ...baseCaps, adapterFeatures: [] }, { tiers });
    expect(id).toBe("Plain-q4f16_1-MLC");
  });
});
