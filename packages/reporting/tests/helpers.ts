import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ReportingDeps, RunCommandResult, WorkerEnvelope, WorkerId } from "../src/types.ts";

function ok(stdout: string): RunCommandResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false, aborted: false };
}

export interface MockDepsOptions {
  gitSha?: string;
  fileManifest?: string[];
  workerEnvelopes?: Partial<Record<WorkerId, WorkerEnvelope>>;
  sourceContent?: Record<string, string>;
  failCodex?: boolean;
  onCodexRun?: (args: string[]) => void;
}

export function createMockDeps(options: MockDepsOptions = {}): ReportingDeps {
  const gitSha = options.gitSha ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const fileManifest = options.fileManifest ?? [
    "package.json",
    "README.md",
    "packages/a2a/src/server.ts",
    "packages/acp/src/connection.ts",
    "packages/reporting/src/index.ts",
    "apps/internal-gateway/index.ts",
    "packages/validation/src/index.ts",
    "tests/integration/gateway-e2e.test.ts",
  ];

  return {
    runCommand: async (command, args) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") {
        return ok(`${gitSha}\n`);
      }

      if (command === "git" && args.join(" ") === "rev-parse --abbrev-ref HEAD") {
        return ok("main\n");
      }

      if (command === "git" && args.join(" ") === "status --short --branch") {
        return ok("## main\n");
      }

      if (command === "rg") {
        return ok(`${fileManifest.join("\n")}\n`);
      }

      if (command === "codex") {
        options.onCodexRun?.(args);

        if (options.failCodex) {
          return {
            stdout: "",
            stderr: "command not found: codex",
            exitCode: 127,
            timedOut: false,
            aborted: false,
          };
        }

        const schemaIndex = args.indexOf("--output-schema");
        const schemaArg = schemaIndex >= 0 ? args[schemaIndex + 1] : undefined;
        const schemaName = schemaArg ? basename(schemaArg) : "";
        const workerId = schemaName.replace(".schema.json", "") as WorkerId;

        const envelope =
          options.workerEnvelopes?.[workerId] ??
          buildEnvelope(workerId, [
            {
              severity: "P2",
              title: `${workerId} finding`,
              body: `Issue from ${workerId}`,
              file: "packages/a2a/src/server.ts",
              line: 10,
              confidence: 0.8,
              evidenceRefs: ["local:sample"],
            },
          ]);

        const messageText = JSON.stringify(envelope);
        const jsonl = [
          JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "item-1", type: "agent_message", text: messageText },
          }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
        ].join("\n");

        return ok(`${jsonl}\n`);
      }

      return {
        stdout: "",
        stderr: `unsupported command ${command}`,
        exitCode: 1,
        timedOut: false,
        aborted: false,
      };
    },
    fetchText: async (url) => {
      return options.sourceContent?.[url] ?? `source:${url}`;
    },
    writeFile: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    mkdirp: async (path) => {
      await mkdir(path, { recursive: true });
    },
    readFile: async (path) => readFile(path, "utf8"),
  };
}

interface BuildFindingInput {
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  body: string;
  file?: string;
  line?: number;
  confidence?: number;
  evidenceRefs: string[];
}

export function buildEnvelope(workerId: WorkerId, findings: BuildFindingInput[]): WorkerEnvelope {
  return {
    workerId,
    findings,
    componentNotes: [
      {
        component: "@agents-js/a2a",
        summary: `Note from ${workerId}`,
      },
    ],
    citations: [
      {
        sourceId: "jsoncanvas_spec",
        url: "https://jsoncanvas.org/spec/1.0/",
        note: `Citation from ${workerId}`,
      },
    ],
  };
}
