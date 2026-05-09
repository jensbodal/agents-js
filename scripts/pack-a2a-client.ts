import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "@agents-js/gateway-runtime";

const repoRoot = path.resolve(import.meta.dir, "..");
const releaseCandidatesRoot = path.join(repoRoot, ".tmp", "release-candidates");
const policyPath = path.join(repoRoot, "packages", "policy");
const validationPath = path.join(repoRoot, "packages", "validation");
const acpPath = path.join(repoRoot, "packages", "acp");
const a2aPath = path.join(repoRoot, "packages", "a2a");
const a2aClientPath = path.join(repoRoot, "packages", "a2a-client");
const aguiTypesPath = path.join(repoRoot, "packages", "agui-types");
const a2uiTypesPath = path.join(repoRoot, "packages", "a2ui-types");

type PackageManifest = {
  name: string;
  version: string;
};

export type SmokeConsumerPackageJson = {
  name: string;
  private: true;
  type: "module";
  dependencies: Record<string, string>;
  overrides?: Record<string, string>;
};

type PackedArtifactMetadata = {
  name: string;
  tarballPath: string;
  sha256: string;
  bytes: number;
};

type DirectorySnapshot = {
  sourcePath: string;
  backupPath: string | null;
};

export type HandoffManifest = {
  releaseDate: string;
  artifactDir: string;
  packages: {
    acp: PackedArtifactMetadata;
    a2a: PackedArtifactMetadata;
    policy: PackedArtifactMetadata;
    validation: PackedArtifactMetadata;
    aguiTypes: PackedArtifactMetadata;
    a2uiTypes: PackedArtifactMetadata;
    a2aClient: PackedArtifactMetadata;
  };
};

export type RunExternalConsumerSmokeOptions = {
  releaseDate?: string;
  smokeSource?: string;
};

export type RunExternalConsumerSmokeResult = {
  artifactDir: string;
  acpTarball: string;
  a2aTarball: string;
  policyTarball: string;
  validationTarball: string;
  aguiTypesTarball: string;
  a2uiTypesTarball: string;
  a2aClientTarball: string;
  manifestPath: string;
  output: string;
};

async function readManifest(packageDir: string): Promise<PackageManifest> {
  return Bun.file(path.join(packageDir, "package.json")).json();
}

function formatLocalDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).format(now);
}

function defaultReleaseDate(now = new Date()): string {
  return `${formatLocalDate(now)}-local-smoke-${now.getTime()}`;
}

function parseCliArgs(argv: string[]) {
  let releaseDate: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--release-date") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('Missing value for "--release-date".');
      }
      releaseDate = next;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument "${arg}". Supported args: --release-date <release-key>.`);
  }

  return { releaseDate };
}

export function resolveReleaseDate(
  argv = Bun.argv.slice(2),
  envReleaseDate = parseEnv("AGENTS_JS_RC_DATE").optional().string(),
): string {
  const cliArgs = parseCliArgs(argv);
  return cliArgs.releaseDate ?? envReleaseDate ?? defaultReleaseDate();
}

export function getArtifactDir(releaseDate: string): string {
  return path.join(releaseCandidatesRoot, releaseDate);
}

async function buildPackage(packageDir: string): Promise<void> {
  await Bun.$`bun run build`.cwd(packageDir).quiet();
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

  const backupPath = path.join(
    backupRoot,
    sourcePath.replaceAll(path.sep, "__").replaceAll(":", "_"),
  );
  await mkdir(path.dirname(backupPath), { recursive: true });
  await cp(sourcePath, backupPath, { recursive: true });
  return { sourcePath, backupPath };
}

async function restoreDirectorySnapshots(snapshots: DirectorySnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    await rm(snapshot.sourcePath, { recursive: true, force: true });
    if (snapshot.backupPath) {
      await cp(snapshot.backupPath, snapshot.sourcePath, { recursive: true });
    }
  }
}

async function packReleaseCandidate(packageDir: string, artifactDir: string): Promise<string> {
  const manifest = await readManifest(packageDir);
  const tarballName = `${manifest.name.replace(/^@/, "").replace(/\//g, "-")}-${manifest.version}.tgz`;

  await Bun.$`bun pm pack --destination ${artifactDir}`.cwd(packageDir).quiet();

  return path.join(artifactDir, tarballName);
}

async function createConsumerInstallEnv(tempDir: string): Promise<Record<string, string>> {
  const isolatedTmpDir = path.join(tempDir, ".tmp");
  const isolatedCacheDir = path.join(tempDir, ".bun-install-cache");

  await mkdir(isolatedTmpDir, { recursive: true });
  await mkdir(isolatedCacheDir, { recursive: true });

  return {
    ...process.env,
    TMPDIR: isolatedTmpDir,
    TMP: isolatedTmpDir,
    TEMP: isolatedTmpDir,
    BUN_INSTALL_CACHE_DIR: isolatedCacheDir,
  };
}

async function runBunCommand(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
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

export async function ensureArtifactDirDoesNotExist(artifactDir: string) {
  try {
    await access(artifactDir);
  } catch {
    await mkdir(artifactDir, { recursive: true });
    return;
  }

  throw new Error(
    `Refusing to overwrite existing RC artifacts at ${artifactDir}. Set AGENTS_JS_RC_DATE to a new value.`,
  );
}

async function sha256(filePath: string): Promise<string> {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

export function buildSmokeConsumerPackageJson(
  a2aClientTarball: string,
  a2aTarball: string,
  acpTarball: string,
  validationTarball: string,
  policyTarball: string,
  aguiTypesTarball?: string,
  a2uiTypesTarball?: string,
): SmokeConsumerPackageJson {
  const overrides: Record<string, string> = {
    "@agents-js/acp": `file:${acpTarball}`,
    "@agents-js/a2a": `file:${a2aTarball}`,
    "@agents-js/validation": `file:${validationTarball}`,
    "@agents-js/policy": `file:${policyTarball}`,
  };
  if (aguiTypesTarball) {
    overrides["@agents-js/agui-types"] = `file:${aguiTypesTarball}`;
  }
  if (a2uiTypesTarball) {
    overrides["@agents-js/a2ui-types"] = `file:${a2uiTypesTarball}`;
  }

  return {
    name: "agents-js-a2a-client-consumer-smoke",
    private: true,
    type: "module",
    dependencies: {
      "@a2a-js/sdk": "^0.3.13",
      "@agents-js/a2a-client": `file:${a2aClientTarball}`,
      "@agents-js/policy": `file:${policyTarball}`,
      "@agents-js/validation": `file:${validationTarball}`,
    },
    // Override internal package dependencies so bun resolves them from
    // local tarballs instead of a registry during smoke testing.
    overrides,
  };
}

const defaultSmokeSource = `
import { A2AClientController, createInitialSessionState, isTerminalTaskState } from "@agents-js/a2a-client";

// Verify A2AClientController is a constructor
if (typeof A2AClientController !== "function") {
  throw new Error("Expected A2AClientController to be a constructor function.");
}

// Verify createInitialSessionState returns expected shape
const state = createInitialSessionState();
if (state.status !== "idle") {
  throw new Error(\`Expected initial session status "idle", got "\${state.status}".\`);
}

// Verify isTerminalTaskState works
if (isTerminalTaskState("completed") !== true) {
  throw new Error("Expected isTerminalTaskState('completed') to return true.");
}
if (isTerminalTaskState("working") !== false) {
  throw new Error("Expected isTerminalTaskState('working') to return false.");
}

console.log("external consumer smoke passed");
`;

async function buildHandoffManifest(
  releaseDate: string,
  artifactDir: string,
  acpTarball: string,
  a2aTarball: string,
  policyTarball: string,
  validationTarball: string,
  aguiTypesTarball: string,
  a2uiTypesTarball: string,
  a2aClientTarball: string,
): Promise<HandoffManifest> {
  const acpStats = await stat(acpTarball);
  const a2aStats = await stat(a2aTarball);
  const policyStats = await stat(policyTarball);
  const validationStats = await stat(validationTarball);
  const aguiTypesStats = await stat(aguiTypesTarball);
  const a2uiTypesStats = await stat(a2uiTypesTarball);
  const a2aClientStats = await stat(a2aClientTarball);

  return {
    releaseDate,
    artifactDir,
    packages: {
      acp: {
        name: "@agents-js/acp",
        tarballPath: acpTarball,
        sha256: await sha256(acpTarball),
        bytes: acpStats.size,
      },
      a2a: {
        name: "@agents-js/a2a",
        tarballPath: a2aTarball,
        sha256: await sha256(a2aTarball),
        bytes: a2aStats.size,
      },
      policy: {
        name: "@agents-js/policy",
        tarballPath: policyTarball,
        sha256: await sha256(policyTarball),
        bytes: policyStats.size,
      },
      validation: {
        name: "@agents-js/validation",
        tarballPath: validationTarball,
        sha256: await sha256(validationTarball),
        bytes: validationStats.size,
      },
      aguiTypes: {
        name: "@agents-js/agui-types",
        tarballPath: aguiTypesTarball,
        sha256: await sha256(aguiTypesTarball),
        bytes: aguiTypesStats.size,
      },
      a2uiTypes: {
        name: "@agents-js/a2ui-types",
        tarballPath: a2uiTypesTarball,
        sha256: await sha256(a2uiTypesTarball),
        bytes: a2uiTypesStats.size,
      },
      a2aClient: {
        name: "@agents-js/a2a-client",
        tarballPath: a2aClientTarball,
        sha256: await sha256(a2aClientTarball),
        bytes: a2aClientStats.size,
      },
    },
  };
}

export async function runExternalConsumerSmoke(
  options: RunExternalConsumerSmokeOptions = {},
): Promise<RunExternalConsumerSmokeResult> {
  const releaseDate = options.releaseDate ?? resolveReleaseDate();
  const artifactDir = getArtifactDir(releaseDate);
  const manifestPath = path.join(artifactDir, "a2a-client-rc-manifest.json");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agents-js-a2a-client-consumer-"));
  const buildBackupRoot = path.join(tempDir, "build-output-backups");
  const distSnapshots = await Promise.all([
    snapshotDirectory(path.join(policyPath, "dist"), buildBackupRoot),
    snapshotDirectory(path.join(validationPath, "dist"), buildBackupRoot),
    snapshotDirectory(path.join(acpPath, "dist"), buildBackupRoot),
    snapshotDirectory(path.join(a2aPath, "dist"), buildBackupRoot),
    snapshotDirectory(path.join(aguiTypesPath, "dist"), buildBackupRoot),
    snapshotDirectory(path.join(a2aClientPath, "dist"), buildBackupRoot),
    snapshotDirectory(path.join(a2uiTypesPath, "dist"), buildBackupRoot),
  ]);

  await ensureArtifactDirDoesNotExist(artifactDir);

  try {
    // Build the first-party dependency closure so the external consumer smoke
    // cannot fall through to the public registry for unpublished packages.
    await buildPackage(policyPath);
    await buildPackage(acpPath);
    await buildPackage(aguiTypesPath);
    await buildPackage(a2uiTypesPath);
    await buildPackage(validationPath);
    await buildPackage(a2aPath);
    await buildPackage(a2aClientPath);

    const aguiTypesTarball = await packReleaseCandidate(aguiTypesPath, artifactDir);
    const a2uiTypesTarball = await packReleaseCandidate(a2uiTypesPath, artifactDir);
    const acpTarball = await packReleaseCandidate(acpPath, artifactDir);
    const a2aTarball = await packReleaseCandidate(a2aPath, artifactDir);
    const policyTarball = await packReleaseCandidate(policyPath, artifactDir);
    const validationTarball = await packReleaseCandidate(validationPath, artifactDir);
    const a2aClientTarball = await packReleaseCandidate(a2aClientPath, artifactDir);
    const packageJson = buildSmokeConsumerPackageJson(
      a2aClientTarball,
      a2aTarball,
      acpTarball,
      validationTarball,
      policyTarball,
      aguiTypesTarball,
      a2uiTypesTarball,
    );
    const handoffManifest = await buildHandoffManifest(
      releaseDate,
      artifactDir,
      acpTarball,
      a2aTarball,
      policyTarball,
      validationTarball,
      aguiTypesTarball,
      a2uiTypesTarball,
      a2aClientTarball,
    );

    const installEnv = await createConsumerInstallEnv(tempDir);
    await writeFile(
      path.join(tempDir, "package.json"),
      `${JSON.stringify(packageJson, null, 2)}\n`,
    );
    await writeFile(
      path.join(tempDir, "smoke.ts"),
      (options.smokeSource ?? defaultSmokeSource).trimStart(),
    );

    await runBunCommand(["bun", "install"], tempDir, installEnv);
    const output = await runBunCommand(["bun", "run", "smoke.ts"], tempDir, installEnv);

    if (!output.includes("external consumer smoke passed")) {
      throw new Error("External consumer smoke test did not report success.");
    }

    await writeFile(manifestPath, `${JSON.stringify(handoffManifest, null, 2)}\n`);

    console.log(`A2A Client RC artifact directory: ${artifactDir}`);
    console.log(`ACP RC tarball: ${acpTarball}`);
    console.log(`A2A RC tarball: ${a2aTarball}`);
    console.log(`Policy RC tarball: ${policyTarball}`);
    console.log(`Validation RC tarball: ${validationTarball}`);
    console.log(`AG-UI Types RC tarball: ${aguiTypesTarball}`);
    console.log(`A2UI Types RC tarball: ${a2uiTypesTarball}`);
    console.log(`A2A Client RC tarball: ${a2aClientTarball}`);
    console.log(`A2A Client RC manifest: ${manifestPath}`);
    console.log(output.trim());

    return {
      artifactDir,
      acpTarball,
      a2aTarball,
      policyTarball,
      validationTarball,
      aguiTypesTarball,
      a2uiTypesTarball,
      a2aClientTarball,
      manifestPath,
      output: output.trim(),
    };
  } finally {
    await restoreDirectorySnapshots(distSnapshots);
    await rm(tempDir, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  await runExternalConsumerSmoke();
}
