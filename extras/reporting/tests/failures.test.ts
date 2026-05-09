import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReportWithDeps } from "../src/orchestrator.ts";
import type { RunCommandOptions } from "../src/types.ts";
import { createMockDeps } from "./helpers.ts";

describe("failure behavior", () => {
  test("fails with deterministic message when codex is missing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agents-js-reporting-fail-"));
    const repoRoot = join(tempRoot, "repo");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "demo" }, null, 2));

    const deps = createMockDeps({ failCodex: true });

    await expect(
      generateReportWithDeps(
        {
          repoRoot,
          outDir: join(tempRoot, "reports"),
        },
        deps,
      ),
    ).rejects.toThrow("codex CLI is not available in PATH");

    await rm(tempRoot, { recursive: true, force: true });
  });

  test("fails hard on schema mismatch", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agents-js-reporting-fail-"));
    const repoRoot = join(tempRoot, "repo");
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "demo" }, null, 2));

    const baseDeps = createMockDeps();
    const deps = {
      ...baseDeps,
      runCommand: async (command: string, args: string[], opts: RunCommandOptions) => {
        if (command === "codex") {
          const badJsonl = [
            JSON.stringify({ type: "thread.started" }),
            JSON.stringify({
              type: "item.completed",
              item: { id: "item-1", type: "agent_message", text: '{"workerId":"arch_worker"}' },
            }),
          ].join("\n");
          return {
            stdout: `${badJsonl}\n`,
            stderr: "",
            exitCode: 0,
            timedOut: false,
            aborted: false,
          };
        }

        return baseDeps.runCommand(command, args, opts);
      },
    };

    await expect(
      generateReportWithDeps(
        {
          repoRoot,
          outDir: join(tempRoot, "reports"),
        },
        deps,
      ),
    ).rejects.toThrow("findings must be an array");

    await rm(tempRoot, { recursive: true, force: true });
  });
});
