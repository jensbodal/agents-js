import { fileURLToPath } from "node:url";
import type { ReportProfileId, Severity, WorkerDefinition } from "./types.ts";

export const DEFAULT_MODEL = "gpt-5.3-codex-spark" as const;
export const DEFAULT_MAX_CONCURRENCY = 4;
export const DEFAULT_OUT_DIR = "_dot/reports";

export const SEVERITY_ORDER: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function workerSchemaPath(fileName: string): string {
  return fileURLToPath(new URL(`../schemas/${fileName}`, import.meta.url));
}

export const WORKERS: WorkerDefinition[] = [
  {
    workerId: "arch_worker",
    focus: "Repository architecture, package boundaries, and dependency shape.",
    schemaPath: workerSchemaPath("arch_worker.schema.json"),
  },
  {
    workerId: "runtime_worker",
    focus: "Runtime behavior, protocol bridges, error paths, and resilience risks.",
    schemaPath: workerSchemaPath("runtime_worker.schema.json"),
  },
  {
    workerId: "test_worker",
    focus: "Test quality, coverage gaps, regression surfaces, and brittle tests.",
    schemaPath: workerSchemaPath("test_worker.schema.json"),
  },
  {
    workerId: "config_docs_worker",
    focus: "Configuration and documentation drift, stale paths, and workflow breakage.",
    schemaPath: workerSchemaPath("config_docs_worker.schema.json"),
  },
  {
    workerId: "security_worker",
    focus: "Security posture including permissioning, process boundaries, and unsafe defaults.",
    schemaPath: workerSchemaPath("security_worker.schema.json"),
  },
  {
    workerId: "spec_worker",
    focus: "JSON Canvas compatibility plus codex orchestration contract checks.",
    schemaPath: workerSchemaPath("spec_worker.schema.json"),
  },
];

export const WEB_ALLOWLIST_SOURCES = [
  {
    sourceId: "jsoncanvas_spec",
    url: "https://jsoncanvas.org/spec/1.0/",
  },
  {
    sourceId: "jsoncanvas_repo",
    url: "https://github.com/obsidianmd/jsoncanvas",
  },
  {
    sourceId: "codex_multi_agents",
    url: "https://developers.openai.com/codex/concepts/multi-agents",
  },
  {
    sourceId: "codex_noninteractive",
    url: "https://developers.openai.com/codex/noninteractive",
  },
  {
    sourceId: "codex_sdk",
    url: "https://developers.openai.com/codex/sdk",
  },
  {
    sourceId: "structured_outputs",
    url: "https://platform.openai.com/docs/guides/structured-outputs",
  },
] as const;

export const PROFILE_DESCRIPTIONS: Record<ReportProfileId, string> = {
  generic: "Generic TypeScript/Bun repository profile.",
  "agents-js": "Preset tuned for the agents-js ACP/A2A gateway repository.",
};

export const SNAPSHOT_COMMANDS: Array<{ name: string; command: string[] }> = [
  {
    name: "git_branch",
    command: ["git", "rev-parse", "--abbrev-ref", "HEAD"],
  },
  {
    name: "git_status",
    command: ["git", "status", "--short", "--branch"],
  },
  {
    name: "workspace_packages",
    command: ["rg", "--files", "packages", "apps", "libs", "tests", "docs"],
  },
];
