import { spawn } from "node:child_process";

export interface CodexRunResult {
  /** Optional text to send back through gateway send_message. */
  readonly reply?: string;
}

export interface CodexRunner {
  run(prompt: string): Promise<CodexRunResult>;
}

export type SpawnImpl = typeof spawn;

export interface ExecResumeCodexRunnerOptions {
  readonly command?: string;
  readonly args?: string[];
  readonly spawnImpl?: SpawnImpl;
}

/**
 * v1 delivery adapter: `codex exec resume --last --json -`.
 *
 * The prompt is written to stdin. JSONL parsing is deliberately conservative:
 * if no assistant/final text is recognized, the turn is still considered
 * delivered but produces no auto-reply.
 */
export class ExecResumeCodexRunner implements CodexRunner {
  private readonly command: string;
  private readonly args: string[];
  private readonly spawnImpl: SpawnImpl;

  constructor(options: ExecResumeCodexRunnerOptions = {}) {
    this.command = options.command ?? "codex";
    this.args = options.args ?? ["exec", "resume", "--last", "--json", "-"];
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  run(prompt: string): Promise<CodexRunResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`codex exec resume failed exit=${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        resolve({ reply: extractReplyFromJsonl(stdout) });
      });
      child.stdin?.end(prompt);
    });
  }
}

export interface JsonRpcClient {
  request(method: string, params: unknown): Promise<unknown>;
}

export class AppServerCodexRunner implements CodexRunner {
  constructor(private readonly client: JsonRpcClient) {}

  async run(prompt: string): Promise<CodexRunResult> {
    const thread = await this.client.request("thread/resume", { last: true });
    const threadId =
      typeof thread === "object" && thread !== null && "thread_id" in thread
        ? String((thread as { thread_id: unknown }).thread_id)
        : undefined;
    const turn = await this.client.request("turn/start", { thread_id: threadId, prompt });
    return { reply: extractReplyFromObject(turn) };
  }
}

export async function proveAppServerRunner(client: JsonRpcClient): Promise<boolean> {
  try {
    await client.request("thread/resume", { last: true });
    await client.request("turn/start", { dry_run: true, prompt: "agents-js app-server proof" });
    return true;
  } catch {
    return false;
  }
}

export interface SelectCodexRunnerOptions {
  readonly explicitRunner?: CodexRunner;
  readonly appServerClient?: JsonRpcClient;
  readonly execRunner?: CodexRunner;
  readonly logger?: { log(message: string): void; warn(message: string): void };
}

export async function selectCodexRunner(
  options: SelectCodexRunnerOptions = {},
): Promise<CodexRunner> {
  if (options.explicitRunner) return options.explicitRunner;
  if (options.appServerClient) {
    const proven = await proveAppServerRunner(options.appServerClient);
    if (proven) {
      options.logger?.log("codex-runner=app-server");
      return new AppServerCodexRunner(options.appServerClient);
    }
    options.logger?.warn("codex-app-server-proof-failed; falling back to exec-resume");
  }
  options.logger?.log("codex-runner=exec-resume");
  return options.execRunner ?? new ExecResumeCodexRunner();
}

function extractReplyFromJsonl(stdout: string): string | undefined {
  let last: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      last = extractReplyFromObject(JSON.parse(line)) ?? last;
    } catch {
      // Ignore non-JSON noise; Codex JSONL streams are the contract.
    }
  }
  return last;
}

function extractReplyFromObject(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ["reply", "final", "output", "content", "text"]) {
    const candidate = obj[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  const message = obj.message;
  if (typeof message === "object" && message !== null) {
    const content = (message as Record<string, unknown>).content;
    if (typeof content === "string" && content.trim()) return content;
  }
  return undefined;
}
