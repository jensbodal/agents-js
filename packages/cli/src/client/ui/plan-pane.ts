/**
 * Plan pane — renders the agent's structured todo-list as a checklist
 * tree above the transcript.
 *
 * Source: `state.currentPlan` (ACP `plan` notifications surfaced by
 * the executor's `onPlanUpdate` sink call). The full SDK-typed
 * `PlanEntry[]` flows through, so `priority` is the typed enum
 * (`"high"` / `"medium"` / `"low"`) and `status` is the typed enum
 * (`"pending"` / `"in_progress"` / `"completed"`).
 *
 * Hides itself (zero rows) when `currentPlan === null` so the layout
 * doesn't reserve space for an absent plan. Mounts when the harness
 * starts reporting one — claude-agent-acp emits these mid-turn during
 * planning, so the pane will pop in and out as the agent works.
 *
 * Rendering style: matches Claude Code / Codex CLI conventions:
 *   `[x] step 1 (high)`     — completed
 *   `[~] step 2 (medium)`   — in_progress
 *   `[ ] step 3 (low)`      — pending
 *   `[!] step 4 (high)`     — blocked / unknown
 *
 * Read-only consumer of session state — the pane never mutates the
 * plan, just renders it.
 */
import type { A2ASessionState } from "@agents-js/a2a-client";
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";

export interface ClientPlanPane {
  root: BoxRenderable;
  update(state: A2ASessionState): void;
}

function statusGlyph(status: string): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[~]";
    case "pending":
      return "[ ]";
    default:
      return "[!]";
  }
}

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "#9ece6a";
    case "in_progress":
      return "#7dcfff";
    case "pending":
      return "#7aa2f7";
    default:
      return "#f7768e";
  }
}

export function createClientPlanPane(renderer: CliRenderer): ClientPlanPane {
  const root = new BoxRenderable(renderer, {
    id: "client-plan-pane-root",
    width: "100%",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });

  // We rebuild the entry rows on every update — the entry list is
  // small (typically < 20 items) and the SDK guarantees the wire
  // carries the FULL plan on every notification, so diffing per-row
  // would just add complexity without measurable savings.
  let renderedRows: TextRenderable[] = [];

  return {
    root,
    update(state) {
      // Tear down previous rows. Box height collapses to 0 when
      // empty (flexDirection: column with no children) so the pane
      // takes no layout space when there's no plan to show.
      for (const row of renderedRows) {
        root.remove(row.id);
      }
      renderedRows = [];

      if (state.currentPlan === null || state.currentPlan.length === 0) {
        return;
      }

      for (let i = 0; i < state.currentPlan.length; i++) {
        const entry = state.currentPlan[i];
        if (!entry) continue;
        const glyph = statusGlyph(entry.status);
        const priorityTag = entry.priority ? ` (${entry.priority})` : "";
        const text = new TextRenderable(renderer, {
          id: `client-plan-pane-row-${i}`,
          content: `${glyph} ${entry.content}${priorityTag}`,
          fg: statusColor(entry.status),
        });
        root.add(text);
        renderedRows.push(text);
      }
    },
  };
}
