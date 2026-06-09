import { spawn } from "node:child_process";
import { writeClaudeGatewayMcpConfig } from "./mcp-config.ts";

export interface ClaudeRunResult {
  readonly delivered: true;
}

export interface ClaudeRunner {
  run(prompt: string): Promise<ClaudeRunResult>;
}

export type SpawnImpl = typeof spawn;

export const DEFAULT_CLAUDE_ARGS: readonly string[] = Object.freeze([
  "-p",
  "--disallowedTools",
  "Bash,Edit,Write,WebFetch",
  "--allowedTools",
  "Read,Grep,Glob,mcp__agents_gateway__agents_send_message",
]);

export interface ClaudeSpawnRunnerOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly mcpConfigPath: string;
  readonly identity: string;
  readonly gatewayUrl: string;
  readonly keyCommand: string;
  readonly fetchMode?: string;
  readonly mcpCommand?: string;
  readonly mcpArgs?: readonly string[];
  readonly spawnImpl?: SpawnImpl;
}

export class ClaudeSpawnRunner implements ClaudeRunner {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd?: string;
  private readonly spawnImpl: SpawnImpl;

  constructor(private readonly options: ClaudeSpawnRunnerOptions) {
    this.command = options.command ?? "claude";
    this.args = options.args ?? DEFAULT_CLAUDE_ARGS;
    this.cwd = options.cwd;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async run(prompt: string): Promise<ClaudeRunResult> {
    await writeClaudeGatewayMcpConfig({
      path: this.options.mcpConfigPath,
      identity: this.options.identity,
      gatewayUrl: this.options.gatewayUrl,
      keyCommand: this.options.keyCommand,
      fetchMode: this.options.fetchMode,
      command: this.options.mcpCommand,
      args: this.options.mcpArgs,
    });
    const args = [...this.args, "--strict-mcp-config", "--mcp-config", this.options.mcpConfigPath];
    await spawnClaudeTurn({
      command: this.command,
      args,
      cwd: this.cwd,
      prompt,
      spawnImpl: this.spawnImpl,
    });
    return { delivered: true };
  }
}

function spawnClaudeTurn(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly prompt: string;
  readonly spawnImpl: SpawnImpl;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = input.spawnImpl(input.command, input.args, {
      stdio: ["pipe", "ignore", "pipe"],
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude spawn failed exit=${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve();
    });
    child.stdin?.end(input.prompt);
  });
}

export function splitClaudeArgs(value: string | undefined): readonly string[] | undefined {
  if (!value?.trim()) return undefined;
  return value.trim().split(/\s+/).filter(Boolean);
}
