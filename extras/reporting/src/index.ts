export { buildCanvas } from "./canvas.ts";
export { renderFindingsMarkdown } from "./markdown.ts";
export { mergeFindings } from "./merge.ts";
export { generateReport, generateReportWithDeps } from "./orchestrator.ts";
export type {
  CanvasDoc,
  CanvasEdge,
  CanvasTextNode,
  Finding,
  GenerateReportOptions,
  GenerateReportResult,
  ReportingDeps,
  ReportProfileId,
  RepoSnapshot,
  Severity,
  WorkerEnvelope,
  WorkerFinding,
  WorkerId,
  WorkerResult,
} from "./types.ts";
export { validateCanvasDoc, validateWorkerEnvelope } from "./validation.ts";
