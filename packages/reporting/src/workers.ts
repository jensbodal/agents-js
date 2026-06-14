import { DEFAULT_MAX_CONCURRENCY, DEFAULT_MODEL, WORKERS } from "./constants.ts";
import { normalizeText } from "./hash.ts";
import { extractLastAgentMessage, parseJsonlEvents } from "./jsonl.ts";
import { getProfileDescription } from "./snapshot.ts";
import type {
  GenerateReportOptions,
  ReportingDeps,
  RepoSnapshot,
  WorkerDefinition,
  WorkerResult,
} from "./types.ts";
import { validateWorkerEnvelope } from "./validation.ts";

export async function runWorkers(
  options: GenerateReportOptions,
  snapshot: RepoSnapshot,
  deps: ReportingDeps,
): Promise<WorkerResult[]> {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const model = options.model ?? DEFAULT_MODEL;

  return runWithConcurrency(WORKERS, maxConcurrency, async (worker) => {
    const prompt = buildWorkerPrompt(worker, snapshot);
    const args = [
      "exec",
      "--ephemeral",
      "--json",
      "--model",
      model,
      "--output-schema",
      worker.schemaPath,
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      prompt,
    ];

    const commandResult = await deps.runCommand("codex", args, { cwd: options.repoRoot });

    if (commandResult.exitCode !== 0) {
      const stderr = normalizeText(commandResult.stderr);
      const stdout = normalizeText(commandResult.stdout);
      const message = stderr || stdout || `codex exited with code ${commandResult.exitCode}`;
      if (commandResult.exitCode === 127 || message.includes("command not found")) {
        throw new Error(
          `Failed to run worker ${worker.workerId}: codex CLI is not available in PATH`,
        );
      }
      throw new Error(`Failed to run worker ${worker.workerId}: ${message}`);
    }

    const events = parseJsonlEvents(commandResult.stdout);
    const lastMessage = extractLastAgentMessage(events);

    let parsed: unknown;
    try {
      parsed = JSON.parse(lastMessage);
    } catch (error) {
      throw new Error(
        `Worker ${worker.workerId}: final message is not valid JSON: ${String(error)}. Message: ${lastMessage}`,
        {
          cause: error,
        },
      );
    }

    const envelope = validateWorkerEnvelope(worker.workerId, parsed);

    return {
      workerId: worker.workerId,
      schemaPath: worker.schemaPath,
      prompt,
      envelope,
      rawJsonl: commandResult.stdout,
    };
  });
}

export function buildWorkerPrompt(worker: WorkerDefinition, snapshot: RepoSnapshot): string {
  const filePreview = snapshot.fileManifest.slice(0, 300);
  const sourcePreview = snapshot.sources.map((source) => ({
    sourceId: source.sourceId,
    url: source.url,
    sha256: source.sha256,
  }));
  const componentPreview = snapshot.components.slice(0, 80);

  const context = {
    gitSha: snapshot.gitSha,
    repoName: snapshot.repoName,
    profileId: snapshot.profileId,
    profileDescription: getProfileDescription(snapshot.profileId),
    focus: worker.focus,
    commands: snapshot.commands,
    sourcePreview,
    componentPreview,
    fileManifestPreview: filePreview,
  };

  return [
    "You are a strict codebase analysis worker.",
    `Worker ID: ${worker.workerId}`,
    `Focus: ${worker.focus}`,
    "",
    "Output requirements:",
    "- Return only one JSON object that satisfies the provided JSON schema.",
    "- Do not include markdown fences or extra text.",
    "- Findings must use severities P0, P1, P2, or P3.",
    "- Use deterministic language and stable phrasing.",
    "",
    "Context snapshot (authoritative input):",
    JSON.stringify(context, null, 2),
    "",
    "Analyze the repository in the current working directory and return findings, componentNotes, and citations.",
    "Citations should reference sourceId values from sourcePreview when relevant.",
  ].join("\n");
}

async function runWithConcurrency<T, R>(
  items: T[],
  maxConcurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (maxConcurrency < 1) {
    throw new Error(`maxConcurrency must be >= 1, got ${maxConcurrency}`);
  }

  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(maxConcurrency, items.length) }, async () => {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;

      if (currentIndex >= items.length) {
        return;
      }

      const currentItem = items[currentIndex];
      if (currentItem === undefined) {
        return;
      }
      results[currentIndex] = await mapper(currentItem, currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}
