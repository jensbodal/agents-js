import type { PlanEntryInfo } from "../types/session.ts";
import type { WorkflowCopyMap } from "../workflow-copy.ts";

export function derivePlanSurface(copy: WorkflowCopyMap, plan: PlanEntryInfo[] | null | undefined) {
  const entries = (plan ?? []).map((entry, index) => ({
    ...entry,
    index,
    isCurrent: entry.status === "in_progress",
  }));
  const completedCount = entries.filter((entry) => entry.status === "completed").length;
  const activeEntries = entries.filter((entry) => entry.status === "in_progress");
  const totalCount = entries.length;

  return {
    visible: totalCount > 0,
    summary: totalCount > 0 ? copy.planProgress(completedCount, totalCount) : null,
    completedCount,
    totalCount,
    activeCount: activeEntries.length,
    currentEntryIndex: activeEntries[0]?.index ?? null,
    entries,
  };
}
