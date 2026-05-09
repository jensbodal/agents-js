import type {
  WorkflowSessionStateLike,
  WorkflowSurfaceContext,
  WorkflowSurfaceState,
} from "./types/workflow-surface.ts";
import { resolveWorkflowCopy, type WorkflowCopyMap } from "./workflow-copy.ts";
import { deriveActivitySurface } from "./workflow-surfaces/activity.ts";
import { deriveComposerSurface } from "./workflow-surfaces/composer.ts";
import { describeWorkflowError } from "./workflow-surfaces/error-summary.ts";
import { deriveInterruptSurface } from "./workflow-surfaces/interrupt.ts";
import { derivePlanSurface } from "./workflow-surfaces/plan.ts";
import {
  collectToolCallStats,
  formatToolCallStatus,
  getTrailingToolBlockStats,
  summarizeToolGroup,
} from "./workflow-surfaces/tool-stats.ts";
import { deriveTranscriptSurface } from "./workflow-surfaces/transcript.ts";

export {
  collectToolCallStats,
  describeWorkflowError,
  formatToolCallStatus,
  getTrailingToolBlockStats,
  summarizeToolGroup,
};

export function deriveWorkflowSurfaceState(
  state: WorkflowSessionStateLike | null | undefined,
  context: WorkflowSurfaceContext = {},
  copyOverrides?: Partial<WorkflowCopyMap>,
): WorkflowSurfaceState {
  const copy = resolveWorkflowCopy(copyOverrides);
  const composer_surface = deriveComposerSurface(copy, state, context);
  return {
    plan_surface: derivePlanSurface(copy, state?.plan),
    activity_surface: deriveActivitySurface(copy, state, context, composer_surface),
    interrupt_surface: deriveInterruptSurface(copy, state, context),
    composer_surface,
    transcript_surface: deriveTranscriptSurface(copy, state),
  };
}
