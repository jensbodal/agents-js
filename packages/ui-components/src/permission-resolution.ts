import type { PermissionResolution } from "./ws-types.ts";

export type PermissionModalDetail =
  | {
      outcome: "selected";
      optionId?: string;
      selectedScope?: string;
    }
  | {
      outcome: "cancelled";
      selectedScope?: string;
    };

export function createPermissionResolution(detail: PermissionModalDetail): PermissionResolution {
  if (detail.outcome === "cancelled") {
    return {
      response: {
        outcome: { outcome: "cancelled" },
      },
      selectedScope: detail.selectedScope,
    };
  }

  return {
    response: {
      outcome: {
        outcome: "selected",
        optionId: detail.optionId,
      },
    },
    selectedScope: detail.selectedScope,
  };
}
