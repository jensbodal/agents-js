import { describe, expect, test } from "bun:test";
import {
  deriveFallbackModelId,
  isKnownModelId,
  reconcileModelSelection,
} from "../src/model-selection.ts";

describe("model-selection", () => {
  test("recognizes model ids from both session and runtime metadata", () => {
    const hostState = {
      models: {
        currentModelId: "default",
        availableModels: [{ modelId: "default", name: "Default" }],
      },
      runtimeModels: [{ id: "sonnet", name: "Sonnet", provider: "anthropic" }],
    };

    expect(isKnownModelId(hostState, "default")).toBe(true);
    expect(isKnownModelId(hostState, "sonnet")).toBe(true);
    expect(isKnownModelId(hostState, "stale-model")).toBe(false);
  });

  test("prefers the current session model as the fallback selection", () => {
    const hostState = {
      defaultModelId: "default",
      models: {
        currentModelId: "opus",
        availableModels: [
          { modelId: "default", name: "Default" },
          { modelId: "opus", name: "Opus" },
        ],
      },
      runtimeModels: [{ id: "sonnet", name: "Sonnet", provider: "anthropic" }],
    };

    expect(deriveFallbackModelId(hostState)).toBe("opus");
  });

  test("normalizes a stale saved model to the current backend model without applying it", () => {
    const hostState = {
      models: {
        currentModelId: "default",
        availableModels: [
          { modelId: "default", name: "Default" },
          { modelId: "sonnet", name: "Sonnet" },
        ],
      },
      runtimeModels: [],
    };

    expect(
      reconcileModelSelection({
        hostState,
        pendingModelSelection: "stale-model",
        selectedModelId: "stale-model",
      }),
    ).toEqual({
      applyModelId: null,
      pendingModelSelection: null,
      selectedModelId: "default",
    });
  });

  test("keeps a valid pending model until the backend confirms it", () => {
    const hostState = {
      models: {
        currentModelId: "default",
        availableModels: [
          { modelId: "default", name: "Default" },
          { modelId: "sonnet", name: "Sonnet" },
        ],
      },
      runtimeModels: [{ id: "sonnet", name: "Sonnet", provider: "anthropic" }],
    };

    expect(
      reconcileModelSelection({
        hostState,
        pendingModelSelection: "sonnet",
        selectedModelId: "",
      }),
    ).toEqual({
      applyModelId: "sonnet",
      pendingModelSelection: "sonnet",
      selectedModelId: "sonnet",
    });
  });

  test("defers a pending saved model until model metadata is available", () => {
    const hostState = {};

    expect(
      reconcileModelSelection({
        hostState,
        pendingModelSelection: "sonnet",
        selectedModelId: "",
      }),
    ).toEqual({
      applyModelId: null,
      pendingModelSelection: "sonnet",
      selectedModelId: "",
    });
  });
});
