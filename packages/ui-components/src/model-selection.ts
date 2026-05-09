import type { HostState } from "./ws-types.ts";

function getKnownModelIds(hostState: HostState): Set<string> {
  const ids = new Set<string>();

  for (const model of hostState.models?.availableModels ?? []) {
    if (model.modelId) {
      ids.add(model.modelId);
    }
  }

  for (const model of hostState.runtimeModels ?? []) {
    if (model.id) {
      ids.add(model.id);
    }
  }

  return ids;
}

export function isKnownModelId(hostState: HostState, modelId: string | null | undefined): boolean {
  if (typeof modelId !== "string" || modelId.length === 0) {
    return false;
  }

  return getKnownModelIds(hostState).has(modelId);
}

export function deriveFallbackModelId(hostState: HostState): string | null {
  const knownModelIds = getKnownModelIds(hostState);
  const currentModelId = hostState.models?.currentModelId;
  if (currentModelId && knownModelIds.has(currentModelId)) {
    return currentModelId;
  }

  const defaultModelId = hostState.defaultModelId;
  if (defaultModelId && knownModelIds.has(defaultModelId)) {
    return defaultModelId;
  }

  return hostState.models?.availableModels[0]?.modelId ?? hostState.runtimeModels?.[0]?.id ?? null;
}

export function reconcileModelSelection(params: {
  hostState: HostState;
  pendingModelSelection: string | null;
  selectedModelId: string;
}): {
  applyModelId: string | null;
  pendingModelSelection: string | null;
  selectedModelId: string;
} {
  const { hostState } = params;
  const knownModelIds = getKnownModelIds(hostState);
  const hasKnownModels = knownModelIds.size > 0;
  const fallbackModelId = deriveFallbackModelId(hostState);

  let selectedModelId = params.selectedModelId;
  let pendingModelSelection = params.pendingModelSelection;
  const compatiblePendingModelId = isKnownModelId(hostState, pendingModelSelection)
    ? pendingModelSelection
    : null;

  if (selectedModelId && !isKnownModelId(hostState, selectedModelId)) {
    selectedModelId = compatiblePendingModelId ?? fallbackModelId ?? "";
  }

  if (!selectedModelId) {
    if (compatiblePendingModelId) {
      selectedModelId = compatiblePendingModelId;
    } else if (hasKnownModels || fallbackModelId) {
      selectedModelId = fallbackModelId ?? "";
    }
  }

  if (pendingModelSelection && !compatiblePendingModelId && hasKnownModels) {
    pendingModelSelection = null;
  }

  const applyModelId =
    compatiblePendingModelId &&
    hostState.models?.availableModels?.length &&
    hostState.models.currentModelId !== compatiblePendingModelId
      ? compatiblePendingModelId
      : null;

  return {
    selectedModelId,
    pendingModelSelection,
    applyModelId,
  };
}
