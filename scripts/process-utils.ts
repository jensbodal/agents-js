import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { repoRoot } from "./workspace-config.ts";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type CaptureProcessStreamToFileOptions = {
  label?: string;
  logPath: string;
  onLine?: (line: string) => void;
  tailChars?: number;
  target: "stdout" | "stderr";
};

function appendTail(currentTail: string, chunk: string, tailChars: number): string {
  const combined = `${currentTail}${chunk}`;
  if (combined.length <= tailChars) {
    return combined;
  }

  return combined.slice(-tailChars);
}

function prependRepoBinToPath(pathValue?: string): string {
  const seen = new Set<string>();
  const segments = [
    path.join(repoRoot, "node_modules", ".bin"),
    pathValue ?? process.env.PATH ?? "",
  ]
    .flatMap((value) => value.split(path.delimiter))
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });

  return segments.join(path.delimiter);
}

export function buildProcessEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    PATH: prependRepoBinToPath(overrides.PATH),
  };
}

export function pipeStream(
  stream: ReadableStream<Uint8Array> | null,
  label: string,
  target: "stdout" | "stderr",
  onLine?: (line: string) => void,
): void {
  if (!stream) {
    return;
  }

  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        process[target].write(`[${label}] ${line}\n`);
        onLine?.(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      process[target].write(`[${label}] ${buffer}\n`);
      onLine?.(buffer);
    }
  })();
}

export async function captureProcessStreamToFile(
  stream: ReadableStream<Uint8Array> | null,
  options: CaptureProcessStreamToFileOptions,
): Promise<string> {
  const writer = createWriteStream(options.logPath, { encoding: "utf8" });
  const tailChars = options.tailChars ?? 16_384;
  const prefix = options.label ? `[${options.label}] ` : "";

  if (!stream) {
    writer.end();
    await once(writer, "finish");
    return "";
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let tail = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      writer.write(Buffer.from(value));
      const chunk = decoder.decode(value, { stream: true });
      tail = appendTail(tail, chunk, tailChars);
      buffer += chunk;

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        process[options.target].write(prefix ? `${prefix}${line}\n` : `${line}\n`);
        options.onLine?.(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const flushed = decoder.decode();
    if (flushed) {
      tail = appendTail(tail, flushed, tailChars);
      buffer += flushed;
    }

    if (buffer) {
      process[options.target].write(prefix ? `${prefix}${buffer}\n` : `${buffer}\n`);
      options.onLine?.(buffer);
    }
  } finally {
    writer.end();
    await once(writer, "finish");
  }

  return tail;
}

export function spawnLogged(
  label: string,
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
  } = {},
): Bun.Subprocess<"inherit", "pipe", "pipe"> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd ?? repoRoot,
    env: buildProcessEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });

  pipeStream(proc.stdout, label, "stdout", options.onStdoutLine);
  pipeStream(proc.stderr, label, "stderr", options.onStderrLine);
  return proc;
}

export async function runCommand(
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    allowFailure?: boolean;
    timeoutMs?: number;
    stdin?: "inherit" | "pipe";
  } = {},
): Promise<CommandResult> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd ?? repoRoot,
    env: buildProcessEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin ?? "pipe",
  });

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise =
    options.timeoutMs === undefined
      ? null
      : new Promise<number>((resolve) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            proc.kill();
            resolve(-1);
          }, options.timeoutMs);
        });

  const code =
    timeoutPromise === null ? await proc.exited : await Promise.race([proc.exited, timeoutPromise]);

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  const stdout = await stdoutPromise;
  const stderr = await stderrPromise;

  if ((code !== 0 || timedOut) && !options.allowFailure) {
    const commandDetail = `[process] Command failed (${code}): ${argv.join(" ")}`;
    const timeoutDetail = timedOut
      ? `[process] Command timed out after ${options.timeoutMs}ms: ${argv.join(" ")}`
      : "";
    const outputDetail = [
      stdout.trim() ? `[stdout]\n${stdout.trim()}` : "",
      stderr.trim() ? `[stderr]\n${stderr.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    throw new Error([timeoutDetail, commandDetail, outputDetail].filter(Boolean).join("\n"));
  }

  return { code, stdout, stderr, timedOut };
}

export async function runForeground(
  argv: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): Promise<number> {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd ?? repoRoot,
    env: buildProcessEnv(options.env),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`[process] Command failed (${code}): ${argv.join(" ")}`);
  }

  return code;
}

/**
 * Parse the stdout of `pgrep -P <pid>` into child PIDs.
 *
 * Safety contract: pgrep prints one PID per line and terminates the list with
 * a trailing newline; an empty result set is an empty stdout. Splitting raw on
 * `/\s+/` therefore yields a trailing (and, for whitespace-led output, leading)
 * empty token, so we `.trim()` first and drop any remaining empties with
 * `.filter(Boolean)` before parsing — that keeps blank/whitespace-only stdout
 * mapping to `[]` rather than `[NaN]`. The final integer guard is retained as
 * defense-in-depth against any non-numeric token a future pgrep flag could add.
 */
export function parsePgrepPids(stdout: string): number[] {
  return stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function listChildPids(parentPid: number): number[] {
  const pgrep = Bun.which("pgrep");
  if (!pgrep) {
    return [];
  }

  const result = Bun.spawnSync([pgrep, "-P", String(parentPid)], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    return [];
  }

  return parsePgrepPids(new TextDecoder().decode(result.stdout));
}

function stopProcessTree(pid: number, signal: NodeJS.Signals, seen = new Set<number>()): void {
  if (seen.has(pid)) {
    return;
  }
  seen.add(pid);

  const childPids = listChildPids(pid);

  try {
    process.kill(pid, signal);
  } catch {
    // The process may already be gone.
  }

  for (const childPid of childPids) {
    stopProcessTree(childPid, signal, seen);
  }
}

export function stopProcess(proc: Bun.Subprocess | null | undefined): void {
  if (!proc || !Number.isInteger(proc.pid) || proc.pid <= 0) {
    return;
  }

  stopProcessTree(proc.pid, "SIGTERM");
}

export async function assertPortAvailable(
  host: string,
  port: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: Error | null = null;

  while (Date.now() <= deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer();

        server.once("error", (error: NodeJS.ErrnoException) => {
          server.close();
          if (error.code === "EADDRINUSE") {
            reject(new Error(`[process] ${label} port ${host}:${port} is already in use.`));
            return;
          }
          reject(
            new Error(
              `[process] Could not verify ${label} port ${host}:${port}: ${error.message ?? String(error)}`,
            ),
          );
        });

        server.listen(port, host, () => {
          server.close(() => resolve());
        });
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!lastError.message.includes("already in use")) {
        throw lastError;
      }
      await Bun.sleep(250);
    }
  }

  throw lastError ?? new Error(`[process] ${label} port ${host}:${port} is already in use.`);
}

export async function waitForHttp(url: string, label: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the timeout elapses.
    }

    await Bun.sleep(250);
  }

  throw new Error(`[process] Timed out waiting for ${label} at ${url}.`);
}

export async function waitForGatewayCard(gatewayUrl: string, timeoutMs = 20_000): Promise<void> {
  return waitForHttp(
    `${gatewayUrl.replace(/\/+$/, "")}/.well-known/agent-card.json`,
    "gateway agent card",
    timeoutMs,
  );
}

/**
 * Run `fn` with `process.env[key]` scoped to `value`, restoring the prior value
 * on return. Pass `undefined` to delete the var while `fn` runs. Always restores
 * the original state — including the absent case — even if `fn` throws.
 */
export function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}
