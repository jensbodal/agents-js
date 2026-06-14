import { isAbsolute, join } from "node:path";
import { buildCanvas } from "./canvas.ts";
import { DEFAULT_OUT_DIR } from "./constants.ts";
import { stableStringify } from "./hash.ts";
import { renderFindingsMarkdown } from "./markdown.ts";
import { mergeFindings } from "./merge.ts";
import { defaultDeps } from "./runtime.ts";
import { buildRepoSnapshot } from "./snapshot.ts";
import type {
  GenerateReportOptions,
  GenerateReportResult,
  ReportingDeps,
  SourceSnapshot,
} from "./types.ts";
import { validateCanvasDoc } from "./validation.ts";
import { runWorkers } from "./workers.ts";

export async function generateReport(
  options: GenerateReportOptions,
): Promise<GenerateReportResult> {
  return generateReportWithDeps(options, defaultDeps);
}

export async function generateReportWithDeps(
  options: GenerateReportOptions,
  deps: ReportingDeps,
): Promise<GenerateReportResult> {
  const snapshot = await buildRepoSnapshot(options, deps);
  const workerResults = await runWorkers(options, snapshot, deps);
  const findings = mergeFindings(workerResults);

  const findingsMarkdown = renderFindingsMarkdown(snapshot, findings, workerResults);
  const canvasDoc = validateCanvasDoc(buildCanvas(snapshot, findings));

  const reportDir = join(resolveOutDir(options.repoRoot, options.outDir), snapshot.gitSha);
  await deps.mkdirp(reportDir);

  const findingsPath = join(reportDir, "findings.md");
  const canvasPath = join(reportDir, "project-outline.canvas");
  const evidencePath = join(reportDir, "evidence.json");
  const sourcesPath = join(reportDir, "sources.json");

  await deps.writeFile(findingsPath, findingsMarkdown);
  await deps.writeFile(canvasPath, `${stableStringify(canvasDoc, 2)}\n`);
  await deps.writeFile(
    evidencePath,
    `${stableStringify(buildEvidence(snapshot.sources, workerResults, findings), 2)}\n`,
  );
  await deps.writeFile(sourcesPath, `${stableStringify(snapshot.sources, 2)}\n`);

  return {
    gitSha: snapshot.gitSha,
    reportDir,
    findingsPath,
    canvasPath,
    evidencePath,
    sourcesPath,
    findingsCount: findings.length,
    sourceCount: snapshot.sources.length,
  };
}

function resolveOutDir(repoRoot: string, outDir: string | undefined): string {
  const target = outDir ?? DEFAULT_OUT_DIR;
  return isAbsolute(target) ? target : join(repoRoot, target);
}

function buildEvidence(
  sources: SourceSnapshot[],
  workerResults: Awaited<ReturnType<typeof runWorkers>>,
  findings: ReturnType<typeof mergeFindings>,
): Record<string, unknown> {
  return {
    sources,
    findings,
    workers: workerResults.map((worker) => ({
      workerId: worker.workerId,
      schemaPath: worker.schemaPath,
      prompt: worker.prompt,
      envelope: worker.envelope,
    })),
  };
}
