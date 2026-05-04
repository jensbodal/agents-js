import type { BrowserCapabilities } from "./feature-detect.ts";

/**
 * A single entry in the model-picker priority list. Tiers are tried in order
 * and the first whose `minMemoryGB` and `requiredFeatures` are satisfied by
 * the detected `BrowserCapabilities` wins.
 *
 * `requiredFeatures` lists WebGPU adapter features that must be present
 * (e.g. `"shader-f16"` for fp16-quantized models that depend on shader f16
 * support). Empty/omitted means "no extra feature required".
 */
export interface ModelTier {
  readonly id: string;
  readonly minMemoryGB: number;
  readonly requiredFeatures?: readonly string[];
}

/**
 * Default priority-ordered tier list. Mirrors the original hardcoded
 * decision tree in `chooseModel`:
 *  - >= 8GB RAM → Qwen 1.5B
 *  - >= 4GB RAM → Llama 1B
 *  - any RAM, but only with shader-f16 → SmolLM 360M
 *
 * Consumers targeting different fleets (Pi, phones, beefy laptops) can
 * pass their own list via `chooseModel(caps, { tiers: ... })`.
 */
export const DEFAULT_SUPPORTED_MODELS: readonly ModelTier[] = [
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", minMemoryGB: 8 },
  { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", minMemoryGB: 4 },
  {
    id: "SmolLM2-360M-Instruct-q4f16_1-MLC",
    minMemoryGB: 0,
    requiredFeatures: ["shader-f16"],
  },
] as const;

/**
 * Backwards-compatible flat-id list derived from `DEFAULT_SUPPORTED_MODELS`.
 * Existing consumers and tests that imported `SUPPORTED_MODELS` continue to
 * see the same set of ids in the same order.
 */
export const SUPPORTED_MODELS = [
  "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
  "Llama-3.2-1B-Instruct-q4f16_1-MLC",
  "SmolLM2-360M-Instruct-q4f16_1-MLC",
] as const;

export type SupportedModelId = (typeof SUPPORTED_MODELS)[number];

export interface ChooseModelOptions {
  /**
   * Override the priority-ordered list of model tiers used to resolve a
   * model id. Defaults to `DEFAULT_SUPPORTED_MODELS`.
   */
  readonly tiers?: readonly ModelTier[];
}

/**
 * Pick a model id given the detected browser capabilities. WebGPU and a
 * secure context are hard requirements; the rest of the decision walks the
 * configured tier list in order and returns the first match.
 *
 * Note: with a custom `tiers` list the return type is the wider `string`
 * (the caller-supplied ids may not be in `SupportedModelId`). With the
 * default list the runtime values still match the narrow union; widening
 * the type is the price of keeping the API additive without generics.
 */
export function chooseModel(
  caps: BrowserCapabilities,
  options: ChooseModelOptions = {},
): string | null {
  if (!caps.webgpu || !caps.secureContext) return null;
  const tiers = options.tiers ?? DEFAULT_SUPPORTED_MODELS;
  for (const tier of tiers) {
    if (caps.deviceMemoryGB < tier.minMemoryGB) continue;
    const required = tier.requiredFeatures ?? [];
    if (required.some((f) => !caps.adapterFeatures.includes(f))) continue;
    return tier.id;
  }
  return null;
}
