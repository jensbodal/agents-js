import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSmokeConsumerPackageJson,
  type CatalogManifest,
  ensureArtifactDirDoesNotExist,
  getAcpExternalConsumerSdkRange,
  getArtifactDir,
  resolveCatalogSpec,
  resolveReleaseDate,
  runExternalConsumerSmoke,
} from "../../scripts/acp-external-consumer-smoke.ts";

const cleanupPaths = new Set<string>();

afterEach(async () => {
  for (const cleanupPath of cleanupPaths) {
    await rm(cleanupPath, { recursive: true, force: true });
  }
  cleanupPaths.clear();
});

describe("ACP external consumer smoke helpers", () => {
  test("declares the ACP SDK explicitly in the temporary consumer manifest", () => {
    const manifest = buildSmokeConsumerPackageJson(
      "/tmp/acp.tgz",
      "/tmp/validation.tgz",
      "/tmp/policy.tgz",
    );

    expect(manifest.dependencies["@agentclientprotocol/sdk"]).toBe(
      getAcpExternalConsumerSdkRange(),
    );
    expect(manifest.dependencies["@agents-js/acp"]).toBe("file:/tmp/acp.tgz");
    expect(manifest.dependencies["@agents-js/policy"]).toBe("file:/tmp/policy.tgz");
    expect(manifest.dependencies["@agents-js/validation"]).toBe("file:/tmp/validation.tgz");
  });

  test("uses a unique local-smoke release key by default", () => {
    const releaseDate = resolveReleaseDate([], undefined);

    expect(releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}-local-smoke-\d+$/);
  });

  describe("resolveCatalogSpec", () => {
    const manifest: CatalogManifest = {
      name: "fixture",
      version: "0.0.0",
      catalog: {
        "@agentclientprotocol/sdk": "^0.19.0",
      },
      catalogs: {
        react19: { react: "^19.0.0" },
      },
    };

    test("passes through non-catalog specs unchanged", () => {
      expect(resolveCatalogSpec("^1.2.3", "some-pkg", manifest)).toBe("^1.2.3");
      expect(resolveCatalogSpec("file:/tmp/foo.tgz", "some-pkg", manifest)).toBe(
        "file:/tmp/foo.tgz",
      );
    });

    test("resolves bare 'catalog:' against the default catalog", () => {
      expect(resolveCatalogSpec("catalog:", "@agentclientprotocol/sdk", manifest)).toBe("^0.19.0");
    });

    test("resolves 'catalog:default' against the default catalog", () => {
      expect(resolveCatalogSpec("catalog:default", "@agentclientprotocol/sdk", manifest)).toBe(
        "^0.19.0",
      );
    });

    test("resolves 'catalog:<name>' against the named catalogs bucket", () => {
      expect(resolveCatalogSpec("catalog:react19", "react", manifest)).toBe("^19.0.0");
    });

    test("throws with a bucket-specific hint when the default catalog has no entry", () => {
      expect(() => resolveCatalogSpec("catalog:", "missing-pkg", manifest)).toThrow(
        /repo-root "catalog" has no entry/,
      );
    });

    test("throws with a bucket-specific hint when a named catalog has no entry", () => {
      expect(() => resolveCatalogSpec("catalog:react19", "missing-pkg", manifest)).toThrow(
        /repo-root "catalogs\.react19" has no entry/,
      );
    });
  });

  test("refuses to overwrite an existing artifact directory", async () => {
    const existingDir = await mkdtemp(path.join(tmpdir(), "agents-js-rc-existing-"));
    cleanupPaths.add(existingDir);

    await expect(ensureArtifactDirDoesNotExist(existingDir)).rejects.toThrow(
      "Refusing to overwrite existing RC artifacts",
    );
  });
});

describe("ACP external consumer smoke integration", () => {
  test("writes a manifest with immutable tarball metadata after success", async () => {
    const releaseDate = `test-success-${Date.now()}`;
    const artifactDir = getArtifactDir(releaseDate);
    cleanupPaths.add(artifactDir);

    const result = await runExternalConsumerSmoke({ releaseDate });
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));

    expect(result.output).toBe("external consumer smoke passed");
    expect(manifest.releaseDate).toBe(releaseDate);
    expect(manifest.packages.acp.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.policy.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.validation.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.packages.acp.bytes).toBeGreaterThan(0);
    expect(manifest.packages.policy.bytes).toBeGreaterThan(0);
    expect(manifest.packages.validation.bytes).toBeGreaterThan(0);
  }, 60_000);

  test("does not write a manifest when smoke validation fails", async () => {
    const releaseDate = `test-failure-${Date.now()}`;
    const artifactDir = getArtifactDir(releaseDate);
    const manifestPath = path.join(artifactDir, "acp-rc-manifest.json");
    cleanupPaths.add(artifactDir);

    await expect(
      runExternalConsumerSmoke({
        releaseDate,
        smokeSource: 'throw new Error("intentional smoke failure");',
      }),
    ).rejects.toThrow();

    await expect(access(manifestPath)).rejects.toThrow();
  }, 60_000);
});
