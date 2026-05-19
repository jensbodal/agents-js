import { describe, expect, test } from "bun:test";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const distDir = path.join(packageDir, "dist");

type DirectorySnapshot = {
  sourcePath: string;
  backupPath: string | null;
};

function createCommandEnv(rootDir: string): Record<string, string> {
  const npmCacheDir = path.join(rootDir, ".npm-cache");
  return {
    ...process.env,
    npm_config_cache: npmCacheDir,
    TMPDIR: rootDir,
    TMP: rootDir,
    TEMP: rootDir,
  };
}

async function runCommand(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  // NOTE(process-group): Bun.spawn does not put the child in its own process
  // group and Subprocess.kill() only signals the direct child. This test only
  // awaits natural exit, so the latent leak does not fire. If a future
  // variant adds timeout/kill for long-running commands, see
  // packages/acp-host/src/process.ts for the detached + `process.kill(-pid)`
  // pattern used by the Node spawn sites.
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env,
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(
      [`Command failed (${exitCode}): ${argv.join(" ")}`, stdout.trim(), stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return stdout;
}

async function snapshotDirectory(
  sourcePath: string,
  backupRoot: string,
): Promise<DirectorySnapshot> {
  try {
    await access(sourcePath);
  } catch {
    return { sourcePath, backupPath: null };
  }

  const backupPath = path.join(backupRoot, "dist-backup");
  await cp(sourcePath, backupPath, { recursive: true });
  return { sourcePath, backupPath };
}

async function restoreDirectory(snapshot: DirectorySnapshot): Promise<void> {
  await rm(snapshot.sourcePath, { recursive: true, force: true });
  if (snapshot.backupPath) {
    await cp(snapshot.backupPath, snapshot.sourcePath, { recursive: true });
  }
}

describe("@agents-js/cli package output", () => {
  test("packs a built cli entrypoint with publishable dependency versions", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "agents-js-cli-pack-test-"));
    const distSnapshot = await snapshotDirectory(distDir, artifactDir);

    try {
      const commandEnv = createCommandEnv(artifactDir);
      await runCommand(["bun", "run", "build:pkg"], packageDir, commandEnv);
      const packOutput = await runCommand(
        ["npm", "pack", "--json", "--pack-destination", artifactDir],
        packageDir,
        commandEnv,
      );
      const jsonMatch = packOutput.match(/^\[\s*\n[\s\S]*\n\]$/m);
      if (!jsonMatch) throw new Error("npm pack returned no JSON array");
      const [result] = JSON.parse(jsonMatch[0]) as Array<{ filename: string }>;
      if (!result) throw new Error("npm pack returned no entries");
      const tarballPath = path.join(artifactDir, result.filename);

      const packedManifest = JSON.parse(
        await runCommand(
          ["tar", "-xOf", tarballPath, "package/package.json"],
          packageDir,
          commandEnv,
        ),
      ) as {
        bin?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const packedFiles = await runCommand(["tar", "-tf", tarballPath], packageDir, commandEnv);

      expect(packedManifest.bin?.["agents-js"]).toBe("dist/bin.mjs");
      expect(packedFiles).toContain("package/dist/bin.mjs");
      expect(packedFiles).toContain("package/skills/agents-js/SKILL.md");
      expect(packedManifest.dependencies?.["@agentclientprotocol/claude-agent-acp"]).toBe("0.33.1");
      expect(packedManifest.dependencies?.["@zed-industries/codex-acp"]).toBe("0.14.0");
      expect(
        Object.values(packedManifest.dependencies ?? {}).some((value) =>
          value.startsWith("workspace:"),
        ),
      ).toBe(false);
    } finally {
      await restoreDirectory(distSnapshot);
      await rm(artifactDir, { recursive: true, force: true });
    }
  }, 30_000);
});
