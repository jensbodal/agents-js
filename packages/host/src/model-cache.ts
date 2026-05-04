/**
 * Fetches and caches the list of available models from a runtime CLI command.
 *
 * Runs `<command> models` and parses the output into structured model info.
 * Results are cached in memory so repeated calls return the same value.
 */

export interface RuntimeModelInfo {
  id: string; // full ID like "opencode/big-pickle"
  name: string; // display name like "Big Pickle"
  provider: string; // provider prefix like "opencode"
}

let cachedModels: RuntimeModelInfo[] | undefined;

function titleCase(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function deriveDisplayName(modelPart: string): string {
  return modelPart.split("-").map(titleCase).join(" ");
}

function parseModelLine(line: string): RuntimeModelInfo | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1) {
    // No provider prefix — treat the whole string as both provider and model
    return {
      id: trimmed,
      name: deriveDisplayName(trimmed),
      provider: trimmed,
    };
  }

  const provider = trimmed.slice(0, slashIndex);
  const modelPart = trimmed.slice(slashIndex + 1);

  return {
    id: trimmed,
    name: deriveDisplayName(modelPart),
    provider,
  };
}

export async function fetchRuntimeModels(command: string): Promise<RuntimeModelInfo[]> {
  if (cachedModels !== undefined) {
    return cachedModels;
  }

  try {
    const proc = Bun.spawn([command, "models"], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = 5_000;
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );
    const result = await Promise.race([proc.exited, timeout]);

    if (result === "timeout") {
      proc.kill();
      console.warn(`[Gateway] Model fetch timed out after ${timeoutMs}ms — returning empty list`);
      cachedModels = [];
      return cachedModels;
    }

    const stdout = await new Response(proc.stdout).text();
    const models: RuntimeModelInfo[] = [];

    for (const line of stdout.split("\n")) {
      const info = parseModelLine(line);
      if (info) {
        models.push(info);
      }
    }

    cachedModels = models;
    return cachedModels;
  } catch (err) {
    console.warn(
      "[Gateway] Failed to fetch runtime models:",
      err instanceof Error ? err.message : String(err),
    );
    cachedModels = [];
    return cachedModels;
  }
}
