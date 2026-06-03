import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSmokeConsumerPackageJson,
  ensureArtifactDirDoesNotExist,
  getArtifactDir,
  resolveReleaseDate,
  runExternalConsumerSmoke,
} from "../../scripts/pack-a2a-client.ts";

const cleanupPaths = new Set<string>();
const repoRoot = path.resolve(import.meta.dir, "..", "..");
// Only a2a-client/dist is the smoke's PRIMARY artifact. policy/dist and
// validation/dist are supporting packages that other tests in the parallel
// `bun run test` run legitimately build as part of their own dependsOn
// chains. Asserting on their state here produced false positives in CI
// specifically (local + single-file container runs pass because no parallel
// builder is competing). The invariant that actually matters — "a failed
// smoke must not leave its output behind" — is captured by a2a-client/dist
// alone.
const buildOutputDirs = [path.join(repoRoot, "packages", "a2a-client", "dist")];

type DirectorySnapshot =
  | { exists: false }
  | {
      exists: true;
      digest: string;
    };

async function hashDirectory(dirPath: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(currentPath: string, relativePath: string): Promise<void> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      const entryRelativePath = path.join(relativePath, entry.name);
      hash.update(entryRelativePath);

      if (entry.isDirectory()) {
        await visit(entryPath, entryRelativePath);
        continue;
      }

      hash.update(await readFile(entryPath));
    }
  }

  await visit(dirPath, "");
  return hash.digest("hex");
}

async function snapshotBuildOutputs(): Promise<Record<string, DirectorySnapshot>> {
  const snapshots: Record<string, DirectorySnapshot> = {};

  for (const distPath of buildOutputDirs) {
    try {
      await access(distPath);
      snapshots[distPath] = {
        exists: true,
        digest: await hashDirectory(distPath),
      };
    } catch {
      snapshots[distPath] = { exists: false };
    }
  }

  return snapshots;
}

afterEach(async () => {
  for (const cleanupPath of cleanupPaths) {
    await rm(cleanupPath, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe("A2A client external consumer smoke helpers", () => {
  test("declares the A2A SDK explicitly in the temporary consumer manifest", () => {
    const manifest = buildSmokeConsumerPackageJson(
      "/tmp/a2a-client.tgz",
      "/tmp/a2a.tgz",
      "/tmp/acp.tgz",
      "/tmp/validation.tgz",
      "/tmp/policy.tgz",
      "/tmp/agui-types.tgz",
      "/tmp/a2ui-types.tgz",
    );

    expect(manifest.dependencies["@a2a-js/sdk"]).toBe("1.0.0-alpha.0");
    expect(manifest.dependencies["@agents-js/a2a-client"]).toBe("file:/tmp/a2a-client.tgz");
    expect(manifest.dependencies["@agents-js/policy"]).toBe("file:/tmp/policy.tgz");
    expect(manifest.dependencies["@agents-js/validation"]).toBe("file:/tmp/validation.tgz");
    expect(manifest.overrides).toEqual({
      "@agents-js/acp": "file:/tmp/acp.tgz",
      "@agents-js/a2a": "file:/tmp/a2a.tgz",
      "@agents-js/agui-types": "file:/tmp/agui-types.tgz",
      "@agents-js/a2ui-types": "file:/tmp/a2ui-types.tgz",
      "@agents-js/policy": "file:/tmp/policy.tgz",
      "@agents-js/validation": "file:/tmp/validation.tgz",
    });
  });

  test("uses a unique local-smoke release key by default", () => {
    const releaseDate = resolveReleaseDate([], undefined);

    expect(releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}-local-smoke-\d+$/);
  });

  test("refuses to overwrite an existing artifact directory", async () => {
    const existingDir = await mkdtemp(path.join(tmpdir(), "agents-js-rc-existing-"));
    cleanupPaths.add(existingDir);

    await expect(ensureArtifactDirDoesNotExist(existingDir)).rejects.toThrow(
      "Refusing to overwrite existing RC artifacts",
    );
  });
});

describe("A2A client external consumer smoke integration", () => {
  test("writes a manifest with immutable tarball metadata after success", async () => {
    const releaseDate = `test-a2a-success-${Date.now()}`;
    const artifactDir = getArtifactDir(releaseDate);
    cleanupPaths.add(artifactDir);
    const beforeBuildOutputs = await snapshotBuildOutputs();

    const result = await runExternalConsumerSmoke({ releaseDate });
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const afterBuildOutputs = await snapshotBuildOutputs();

    expect(result.output).toBe("external consumer smoke passed");
    expect(manifest.releaseDate).toBe(releaseDate);
    expect(manifest.packages.acp.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.a2a.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.policy.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.validation.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.aguiTypes.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.a2uiTypes.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.a2aClient.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.acp.bytes).toBeGreaterThan(0);
    expect(manifest.packages.a2a.bytes).toBeGreaterThan(0);
    expect(manifest.packages.policy.bytes).toBeGreaterThan(0);
    expect(manifest.packages.validation.bytes).toBeGreaterThan(0);
    expect(manifest.packages.aguiTypes.bytes).toBeGreaterThan(0);
    expect(manifest.packages.a2uiTypes.bytes).toBeGreaterThan(0);
    expect(manifest.packages.a2aClient.bytes).toBeGreaterThan(0);
    expect(afterBuildOutputs).toEqual(beforeBuildOutputs);
  }, 60_000);

  test("does not write a manifest when smoke validation fails", async () => {
    const releaseDate = `test-a2a-failure-${Date.now()}`;
    const artifactDir = getArtifactDir(releaseDate);
    const manifestPath = path.join(artifactDir, "a2a-client-rc-manifest.json");
    cleanupPaths.add(artifactDir);
    const beforeBuildOutputs = await snapshotBuildOutputs();

    await expect(
      runExternalConsumerSmoke({
        releaseDate,
        smokeSource: 'throw new Error("intentional smoke failure");',
      }),
    ).rejects.toThrow();

    await expect(access(manifestPath)).rejects.toThrow();
    expect(await snapshotBuildOutputs()).toEqual(beforeBuildOutputs);
  }, 60_000);
});
