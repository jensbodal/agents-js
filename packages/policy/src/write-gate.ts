/**
 * Write-gate policy -- evaluates whether a write should proceed to review or be blocked.
 *
 * The gate returns a decision; final approval is host-owned.
 * A convenience diff generator is also exported for hosts that want it.
 *
 * Consolidated from earlier host-policy implementations.
 * Uses cross-platform path handling (POSIX + Windows).
 */

import { isWithinWorkspace } from "./path-utils.ts";

export type WriteGateDecision =
  | {
      action: "allow_to_review";
      reasonCode: "requires_review";
      reason: string;
    }
  | {
      action: "block";
      reasonCode: "outside_workspace";
      reason: string;
    }
  | {
      action: "needs_more_context";
      reasonCode: "missing_workspace_root" | "missing_relative_path";
      reason: string;
    };

/**
 * Evaluates whether a write operation should be reviewed or blocked.
 * Outside-workspace paths are blocked. Everything else goes to review (never auto-approved).
 *
 * Cross-platform: handles both POSIX and Windows paths.
 */
export function evaluateWriteGate(workspaceRoot: string, relativePath: string): WriteGateDecision {
  if (workspaceRoot.trim().length === 0) {
    return {
      action: "needs_more_context",
      reasonCode: "missing_workspace_root",
      reason: "workspaceRoot must be provided before evaluating write review eligibility",
    };
  }

  if (relativePath.trim().length === 0) {
    return {
      action: "needs_more_context",
      reasonCode: "missing_relative_path",
      reason: "relativePath must be provided before evaluating write review eligibility",
    };
  }

  if (!isWithinWorkspace(workspaceRoot, relativePath)) {
    return {
      action: "block",
      reasonCode: "outside_workspace",
      reason: `Path is outside the workspace: ${relativePath}`,
    };
  }

  return {
    action: "allow_to_review",
    reasonCode: "requires_review",
    reason: `Write to ${relativePath} requires host review before approval`,
  };
}

// -- Unified diff generator ---------------------------------------------------

/**
 * Generates a simple unified diff between two strings.
 * No external dependencies -- implements a basic line-based LCS diff.
 */
export function generateUnifiedDiff(oldContent: string, newContent: string): string {
  if (oldContent === newContent) {
    return "";
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  const result: string[] = [];
  result.push("--- a/file");
  result.push("+++ b/file");

  const hunks = computeHunks(oldLines, newLines);

  for (const hunk of hunks) {
    result.push(
      `@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`,
    );
    for (const line of hunk.lines) {
      result.push(line);
    }
  }

  return result.join("\n");
}

// -- Internal diff implementation ---------------------------------------------

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function computeHunks(oldLines: string[], newLines: string[]): Hunk[] {
  const m = oldLines.length;
  const n = newLines.length;

  // For very large files, fall back to a simple line-by-line comparison
  if (m * n > 10_000_000) {
    return computeSimpleHunks(oldLines, newLines);
  }

  // Build LCS length table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    const row = dp[i];
    const previousRow = dp[i - 1];
    const oldLine = oldLines[i - 1];
    if (row === undefined || previousRow === undefined || oldLine === undefined) {
      continue;
    }

    for (let j = 1; j <= n; j++) {
      const newLine = newLines[j - 1];
      if (newLine === undefined) {
        continue;
      }

      if (oldLine === newLine) {
        row[j] = (previousRow[j - 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(previousRow[j] ?? 0, row[j - 1] ?? 0);
      }
    }
  }

  // Backtrack to get the edit script
  const edits: Array<{ type: " " | "-" | "+"; text: string }> = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    const oldLine = i > 0 ? oldLines[i - 1] : undefined;
    const newLine = j > 0 ? newLines[j - 1] : undefined;
    const currentRow = dp[i];
    const previousRow = i > 0 ? dp[i - 1] : undefined;

    if (i > 0 && j > 0 && oldLine !== undefined && oldLine === newLine) {
      edits.unshift({ type: " ", text: oldLine });
      i--;
      j--;
    } else if (
      j > 0 &&
      newLine !== undefined &&
      (i === 0 || (currentRow?.[j - 1] ?? 0) >= (previousRow?.[j] ?? 0))
    ) {
      edits.unshift({ type: "+", text: newLine });
      j--;
    } else if (i > 0 && oldLine !== undefined) {
      edits.unshift({ type: "-", text: oldLine });
      i--;
    } else {
      break;
    }
  }

  return groupIntoHunks(edits);
}

/** Simple fallback for very large files. */
function computeSimpleHunks(oldLines: string[], newLines: string[]): Hunk[] {
  const lines: string[] = [];
  for (const line of oldLines) {
    lines.push(`-${line}`);
  }
  for (const line of newLines) {
    lines.push(`+${line}`);
  }
  return [
    {
      oldStart: 0,
      oldCount: oldLines.length,
      newStart: 0,
      newCount: newLines.length,
      lines,
    },
  ];
}

/** Groups an edit script into unified diff hunks with 3 lines of context. */
function groupIntoHunks(edits: Array<{ type: " " | "-" | "+"; text: string }>): Hunk[] {
  const CONTEXT = 3;
  const hunks: Hunk[] = [];

  const changeIndices: number[] = [];
  for (const [index, edit] of edits.entries()) {
    if (edit.type !== " ") {
      changeIndices.push(index);
    }
  }

  const firstChange = changeIndices[0];
  if (firstChange === undefined) {
    return [];
  }

  const groups: Array<{ start: number; end: number }> = [];
  let groupStart = firstChange;
  let groupEnd = firstChange;

  for (let k = 1; k < changeIndices.length; k++) {
    const idx = changeIndices[k];
    if (idx === undefined) {
      continue;
    }

    if (idx - groupEnd <= CONTEXT * 2) {
      groupEnd = idx;
    } else {
      groups.push({ start: groupStart, end: groupEnd });
      groupStart = idx;
      groupEnd = idx;
    }
  }
  groups.push({ start: groupStart, end: groupEnd });

  for (const group of groups) {
    const contextStart = Math.max(0, group.start - CONTEXT);
    const contextEnd = Math.min(edits.length - 1, group.end + CONTEXT);

    const hunkLines: string[] = [];
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;

    for (let i = 0; i < contextStart; i++) {
      const edit = edits[i];
      if (edit === undefined) {
        continue;
      }

      if (edit.type === " " || edit.type === "-") oldStart++;
      if (edit.type === " " || edit.type === "+") newStart++;
    }

    for (let i = contextStart; i <= contextEnd; i++) {
      const edit = edits[i];
      if (edit === undefined) {
        continue;
      }

      hunkLines.push(`${edit.type}${edit.text}`);
      if (edit.type === " " || edit.type === "-") oldCount++;
      if (edit.type === " " || edit.type === "+") newCount++;
    }

    hunks.push({
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: hunkLines,
    });
  }

  return hunks;
}
