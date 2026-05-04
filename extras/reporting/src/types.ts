import type { RunCommandOptions, RunCommandResult } from "@agents-js/gateway-runtime";

export type { RunCommandOptions, RunCommandResult } from "@agents-js/gateway-runtime";

export type Severity = "P0" | "P1" | "P2" | "P3";

export type WorkerId =
  | "arch_worker"
  | "runtime_worker"
  | "test_worker"
  | "config_docs_worker"
  | "security_worker"
  | "spec_worker";

export type ReportProfileId = "generic" | "agents-js";

export interface GenerateReportOptions {
  repoRoot: string;
  outDir?: string;
  model?: "gpt-5.3-codex-spark";
  maxConcurrency?: number;
  profileId?: ReportProfileId;
}

export interface GenerateReportResult {
  gitSha: string;
  reportDir: string;
  findingsPath: string;
  canvasPath: string;
  evidencePath: string;
  sourcesPath: string;
  findingsCount: number;
  sourceCount: number;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  body: string;
  file?: string;
  line?: number;
  confidence?: number;
  evidenceRefs: string[];
  fingerprint: string;
  workerIds: WorkerId[];
}

export interface WorkerFinding {
  severity: Severity;
  title: string;
  body: string;
  file?: string;
  line?: number;
  confidence?: number;
  evidenceRefs: string[];
}

export interface ComponentNote {
  component: string;
  summary: string;
}

export interface Citation {
  sourceId: string;
  url: string;
  note: string;
}

export interface WorkerEnvelope {
  workerId: WorkerId;
  findings: WorkerFinding[];
  componentNotes: ComponentNote[];
  citations: Citation[];
}

export interface WorkerResult {
  workerId: WorkerId;
  schemaPath: string;
  prompt: string;
  envelope: WorkerEnvelope;
  rawJsonl: string;
}

export interface RepoComponent {
  id: string;
  path: string;
  name: string;
}

export interface SourceSnapshot {
  sourceId: string;
  url: string;
  sha256: string;
  normalizedContent: string;
}

export interface CommandSnapshot {
  name: string;
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RepoSnapshot {
  gitSha: string;
  repoName: string;
  fileManifest: string[];
  commands: CommandSnapshot[];
  sources: SourceSnapshot[];
  components: RepoComponent[];
  profileId: ReportProfileId;
}

export interface CanvasTextNode {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  label?: string;
}

export interface CanvasDoc {
  nodes: CanvasTextNode[];
  edges: CanvasEdge[];
}

export interface ReportingDeps {
  runCommand: (
    command: string,
    args: string[],
    options: RunCommandOptions,
  ) => Promise<RunCommandResult>;
  fetchText: (url: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
  mkdirp: (path: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
}

export interface WorkerDefinition {
  workerId: WorkerId;
  focus: string;
  schemaPath: string;
}
