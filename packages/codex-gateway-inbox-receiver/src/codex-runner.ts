import { spawn } from "node:child_process";

export interface CodexRunResult {
  /** Optional text to send back through gateway send_message. */
  readonly reply?: string;
}

export interface CodexRunner {
  run(prompt: string): Promise<CodexRunResult>;
}

export type SpawnImpl = typeof spawn;

/**
 * Source-owned sandbox modes the receiver may run untrusted gateway-inbox turns
 * under. `danger-full-access` is deliberately NOT assignable here — see #92.
 */
export type EnforcedCodexSandboxMode = "read-only" | "workspace-write";

export interface ExecResumeCodexRunnerOptions {
  readonly command?: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly skipGitRepoCheck?: boolean;
  readonly spawnImpl?: SpawnImpl;
  /**
   * #92 gate: sandbox the resumed `codex exec` runs under. Defaults to
   * `read-only` (least privilege for untrusted peer content). Set to
   * `workspace-write` ONLY as an explicit source-owned decision — never from an
   * env override. `danger-full-access` is not representable.
   */
  readonly sandboxMode?: EnforcedCodexSandboxMode;
}

/**
 * #92 — the codex inbox receiver runs UNTRUSTED peer content through
 * `codex exec`. Without an enforced sandbox it inherits the host's
 * `~/.codex/config.toml` default (commonly `workspace-write`), letting untrusted
 * input run write-capable codex. This enforces a sandbox the way the claude
 * receiver enforces `--disallowedTools`: always present, env-invariant, and
 * refusing the dangerous bypass. `--sandbox` MUST precede `resume` (codex
 * accepts it at the exec level and rejects it after `resume`).
 */
const DANGEROUS_SANDBOX_MODE = "danger-full-access";
const DANGEROUS_BYPASS_FLAG = "--dangerously-bypass-approvals-and-sandbox";

/** Throw if argv carries a dangerous sandbox bypass or full-access mode. */
export function assertNoCodexSandboxBypass(args: readonly string[]): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === DANGEROUS_BYPASS_FLAG) {
      throw new Error(
        `codex-receiver: refusing ${DANGEROUS_BYPASS_FLAG} for untrusted gateway-inbox execution (#92)`,
      );
    }
    if ((a === "--sandbox" || a === "-s") && args[i + 1] === DANGEROUS_SANDBOX_MODE) {
      throw new Error(
        `codex-receiver: refusing --sandbox ${DANGEROUS_SANDBOX_MODE} for untrusted gateway-inbox execution (#92)`,
      );
    }
    if (a === `--sandbox=${DANGEROUS_SANDBOX_MODE}` || a === `-s=${DANGEROUS_SANDBOX_MODE}`) {
      throw new Error(`codex-receiver: refusing ${a} for untrusted gateway-inbox execution (#92)`);
    }
  }
}

/** True if argv already pins a sandbox in any accepted form. */
function hasSandboxFlag(args: readonly string[]): boolean {
  return args.some(
    (a) => a === "--sandbox" || a === "-s" || a.startsWith("--sandbox=") || a.startsWith("-s="),
  );
}

/**
 * Build the enforced `codex exec` argv with `--sandbox <mode>` placed before
 * `resume`. Frozen so callers cannot mutate the gate out.
 */
export function buildEnforcedCodexExecArgs(
  options: { sandboxMode?: EnforcedCodexSandboxMode; skipGitRepoCheck?: boolean } = {},
): readonly string[] {
  const mode = options.sandboxMode ?? "read-only";
  // Defense in depth against a cast past the union.
  if ((mode as string) === DANGEROUS_SANDBOX_MODE) {
    throw new Error(
      `codex-receiver: ${DANGEROUS_SANDBOX_MODE} is not an allowed sandbox mode (#92)`,
    );
  }
  return Object.freeze([
    "exec",
    "--sandbox",
    mode,
    "resume",
    "--last",
    ...(options.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
    "--json",
    "-",
  ]);
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
  private readonly args: readonly string[];
  private readonly cwd?: string;
  private readonly spawnImpl: SpawnImpl;

  constructor(options: ExecResumeCodexRunnerOptions = {}) {
    this.command = options.command ?? "codex";
    if (options.args) {
      // Explicit argv (test / advanced seam) cannot dissolve the #92 gate: it
      // must pin a sandbox and must not carry a dangerous bypass.
      assertNoCodexSandboxBypass(options.args);
      if (!hasSandboxFlag(options.args)) {
        throw new Error(
          "codex-receiver: explicit args must pin --sandbox; the #92 gate cannot be dissolved",
        );
      }
      this.args = Object.freeze([...options.args]);
    } else {
      this.args = buildEnforcedCodexExecArgs({
        sandboxMode: options.sandboxMode,
        skipGitRepoCheck: options.skipGitRepoCheck,
      });
    }
    this.cwd = options.cwd;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  run(prompt: string): Promise<CodexRunResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(this.command, this.args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.cwd ? { cwd: this.cwd } : {}),
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
  readonly execRunnerOptions?: ExecResumeCodexRunnerOptions;
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
  return options.execRunner ?? new ExecResumeCodexRunner(options.execRunnerOptions);
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
