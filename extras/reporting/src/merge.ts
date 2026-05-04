import { SEVERITY_ORDER } from "./constants.ts";
import { normalizeText, sha256 } from "./hash.ts";
import type { Finding, WorkerResult } from "./types.ts";

export function mergeFindings(workerResults: WorkerResult[]): Finding[] {
  const byFingerprint = new Map<string, Finding>();

  for (const worker of workerResults) {
    for (const finding of worker.envelope.findings) {
      const normalizedEvidenceRefs = [
        ...new Set(finding.evidenceRefs.map((entry) => normalizeText(entry))),
      ]
        .filter((entry) => entry.length > 0)
        .sort((a, b) => a.localeCompare(b));

      const fingerprint = createFindingFingerprint({
        severity: finding.severity,
        title: finding.title,
        file: finding.file,
        line: finding.line,
      });

      const existing = byFingerprint.get(fingerprint);
      if (!existing) {
        const id = `f-${sha256(`${worker.workerId}:${fingerprint}`).slice(0, 10)}`;
        byFingerprint.set(fingerprint, {
          id,
          severity: finding.severity,
          title: normalizeText(finding.title),
          body: normalizeText(finding.body),
          file: finding.file,
          line: finding.line,
          confidence: finding.confidence,
          evidenceRefs: normalizedEvidenceRefs,
          fingerprint,
          workerIds: [worker.workerId],
        });
        continue;
      }

      existing.workerIds = [...new Set([...existing.workerIds, worker.workerId])].sort((a, b) =>
        a.localeCompare(b),
      );
      existing.evidenceRefs = [
        ...new Set([...existing.evidenceRefs, ...normalizedEvidenceRefs]),
      ].sort((a, b) => a.localeCompare(b));
      if (typeof finding.confidence === "number") {
        existing.confidence = Math.max(existing.confidence ?? 0, finding.confidence);
      }
    }
  }

  return [...byFingerprint.values()].sort(compareFindings);
}

function createFindingFingerprint(input: {
  severity: string;
  title: string;
  file?: string;
  line?: number;
}): string {
  const base = [
    input.severity,
    normalizeText(input.title).toLowerCase(),
    input.file ?? "",
    String(input.line ?? ""),
  ].join("::");

  return sha256(base);
}

function compareFindings(a: Finding, b: Finding): number {
  const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (severityDiff !== 0) {
    return severityDiff;
  }

  const fileA = a.file ?? "";
  const fileB = b.file ?? "";
  const fileDiff = fileA.localeCompare(fileB);
  if (fileDiff !== 0) {
    return fileDiff;
  }

  const lineA = a.line ?? Number.MAX_SAFE_INTEGER;
  const lineB = b.line ?? Number.MAX_SAFE_INTEGER;
  if (lineA !== lineB) {
    return lineA - lineB;
  }

  const titleDiff = a.title.localeCompare(b.title);
  if (titleDiff !== 0) {
    return titleDiff;
  }

  return a.fingerprint.localeCompare(b.fingerprint);
}
