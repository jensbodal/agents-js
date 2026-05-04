import { SEVERITY_ORDER } from "./constants.ts";
import type { Finding, RepoSnapshot, WorkerResult } from "./types.ts";

export function renderFindingsMarkdown(
  snapshot: RepoSnapshot,
  findings: Finding[],
  workerResults: WorkerResult[],
): string {
  const counts = summarizeSeverities(findings);
  const componentNotes = collectComponentNotes(workerResults);

  const lines: string[] = [];
  lines.push(`# Deterministic Findings Report`);
  lines.push("");
  lines.push(`- Repo: ${snapshot.repoName}`);
  lines.push(`- Commit: ${snapshot.gitSha}`);
  lines.push(`- Profile: ${snapshot.profileId}`);
  lines.push(`- Findings: ${findings.length}`);
  lines.push(
    `- Severity Counts: P0=${counts.P0}, P1=${counts.P1}, P2=${counts.P2}, P3=${counts.P3}`,
  );
  lines.push(`- Sources Snapshotted: ${snapshot.sources.length}`);
  lines.push("");

  lines.push(`## Findings`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("No findings.");
    lines.push("");
  } else {
    for (const finding of findings) {
      const location = finding.file
        ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
        : "n/a";
      const confidence =
        typeof finding.confidence === "number" ? finding.confidence.toFixed(2) : "n/a";
      lines.push(`### [${finding.severity}] ${finding.title}`);
      lines.push("");
      lines.push(finding.body);
      lines.push("");
      lines.push(`- ID: ${finding.id}`);
      lines.push(`- Location: ${location}`);
      lines.push(`- Confidence: ${confidence}`);
      lines.push(`- Workers: ${finding.workerIds.join(", ")}`);
      lines.push(`- Evidence: ${finding.evidenceRefs.join(" | ") || "n/a"}`);
      lines.push("");
    }
  }

  lines.push(`## Component Notes`);
  lines.push("");
  if (componentNotes.length === 0) {
    lines.push("No component notes.");
    lines.push("");
  } else {
    for (const note of componentNotes) {
      lines.push(`- ${note.component}: ${note.summary}`);
    }
    lines.push("");
  }

  lines.push(`## Source Snapshot`);
  lines.push("");
  for (const source of snapshot.sources) {
    lines.push(`- ${source.sourceId}: ${source.url} (${source.sha256})`);
  }

  return `${lines.join("\n")}\n`;
}

function summarizeSeverities(findings: Finding[]): Record<"P0" | "P1" | "P2" | "P3", number> {
  const counts = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };

  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  return counts;
}

function collectComponentNotes(
  workerResults: WorkerResult[],
): Array<{ component: string; summary: string }> {
  const dedup = new Map<string, { component: string; summary: string }>();

  for (const worker of workerResults) {
    for (const note of worker.envelope.componentNotes) {
      const key = `${note.component}::${note.summary}`;
      if (!dedup.has(key)) {
        dedup.set(key, note);
      }
    }
  }

  return [...dedup.values()].sort((a, b) => {
    const componentDiff = a.component.localeCompare(b.component);
    if (componentDiff !== 0) {
      return componentDiff;
    }
    return a.summary.localeCompare(b.summary);
  });
}

export function findingsBySeverity(findings: Finding[]): Map<string, Finding[]> {
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const groups = new Map<string, Finding[]>();

  for (const finding of sorted) {
    const current = groups.get(finding.severity) ?? [];
    current.push(finding);
    groups.set(finding.severity, current);
  }

  return groups;
}
