import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "@agents-js/gateway-runtime";
import { withExternalConsumerSmokeLock } from "./external-consumer-smoke-lock.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const releaseCandidatesRoot = path.join(repoRoot, ".tmp", "release-candidates");
const validationPath = path.join(repoRoot, "packages", "validation");
const acpPath = path.join(repoRoot, "packages", "acp");
const policyPath = path.join(repoRoot, "packages", "policy");
const aguiTypesPath = path.join(repoRoot, "packages", "agui-types");
const a2uiTypesPath = path.join(repoRoot, "packages", "a2ui-types");

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  peerDependencies?: Record<string, string>;
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
    policy: PackedArtifactMetadata;
    validation: PackedArtifactMetadata;
  };
};

export type RunExternalConsumerSmokeOptions = {
  releaseDate?: string;
  smokeSource?: string;
};

export type RunExternalConsumerSmokeResult = {
  artifactDir: string;
  acpTarball: string;
  policyTarball: string;
  validationTarball: string;
  manifestPath: string;
  output: string;
};

const ACP_SDK_PACKAGE_NAME = "@agentclientprotocol/sdk";

let _cachedSdkRange: string | undefined;

export type CatalogManifest = PackageManifest & {
  /** Bun's default catalog (referenced as `"catalog:"` or `"catalog:default"`). */
  catalog?: Record<string, string>;
  /** Bun's named catalogs (referenced as `"catalog:<name>"`). */
  catalogs?: Record<string, Record<string, string>>;
};

/**
 * Resolve a bun catalog-protocol version specifier against a supplied root
 * manifest. Non-catalog specifiers pass through unchanged.
 *
 * Supports:
 *   - `"catalog:"` and `"catalog:default"` → resolved from `rootManifest.catalog`
 *   - `"catalog:<name>"` (any other suffix) → resolved from `rootManifest.catalogs[<name>]`
 *
 * Exported for test use; prefer `dereferenceCatalogSpec` in production paths.
 */
export function resolveCatalogSpec(
  spec: string,
  pkgName: string,
  rootManifest: CatalogManifest,
): string {
  if (!spec.startsWith("catalog:")) return spec;
  const catalogName = spec.slice("catalog:".length) || "default";

  const bucket =
    catalogName === "default" ? rootManifest.catalog : rootManifest.catalogs?.[catalogName];
  const bucketLocation = catalogName === "default" ? '"catalog"' : `"catalogs.${catalogName}"`;
  const resolved = bucket?.[pkgName];

  if (!resolved) {
    throw new Error(
      `Dependency ${pkgName} uses '${spec}' but repo-root ${bucketLocation} has no entry for it. ` +
        `Add it to package.json ${bucketLocation} or change the package's version spec to an explicit range.`,
    );
  }
  return resolved;
}

/** Dereference a `catalog:` spec against the repo-root `package.json`. */
function dereferenceCatalogSpec(spec: string, pkgName: string): string {
  if (!spec.startsWith("catalog:")) return spec;
  const raw = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const rootManifest = JSON.parse(raw) as CatalogManifest;
  return resolveCatalogSpec(spec, pkgName, rootManifest);
}

export function getAcpExternalConsumerSdkRange(): string {
  if (_cachedSdkRange !== undefined) return _cachedSdkRange;
  const raw = readFileSync(path.join(acpPath, "package.json"), "utf8");
  const manifest = JSON.parse(raw) as PackageManifest;
  const sdkSpec =
    manifest.dependencies?.[ACP_SDK_PACKAGE_NAME] ??
    manifest.peerDependencies?.[ACP_SDK_PACKAGE_NAME] ??
    manifest.devDependencies?.[ACP_SDK_PACKAGE_NAME];

  if (!sdkSpec) {
    throw new Error(
      `Unable to determine ${ACP_SDK_PACKAGE_NAME} range from ${acpPath}/package.json`,
    );
  }

  // External consumers can't see the repo-root catalog, so dereference any
  // `catalog:` specifier to the actual version range before handing it out.
  _cachedSdkRange = dereferenceCatalogSpec(sdkSpec, ACP_SDK_PACKAGE_NAME);
  return _cachedSdkRange;
}

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

  await mkdir(artifactDir, { recursive: true });
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
  acpTarball: string,
  validationTarball: string,
  policyTarball: string,
  aguiTypesTarball?: string,
  a2uiTypesTarball?: string,
): SmokeConsumerPackageJson {
  const overrides: Record<string, string> = {
    "@agents-js/acp": `file:${acpTarball}`,
    "@agents-js/policy": `file:${policyTarball}`,
    "@agents-js/validation": `file:${validationTarball}`,
  };
  if (aguiTypesTarball) {
    overrides["@agents-js/agui-types"] = `file:${aguiTypesTarball}`;
  }
  if (a2uiTypesTarball) {
    overrides["@agents-js/a2ui-types"] = `file:${a2uiTypesTarball}`;
  }

  return {
    name: "agents-js-acp-consumer-smoke",
    private: true,
    type: "module",
    dependencies: {
      [ACP_SDK_PACKAGE_NAME]: getAcpExternalConsumerSdkRange(),
      "@agents-js/acp": `file:${acpTarball}`,
      "@agents-js/policy": `file:${policyTarball}`,
      "@agents-js/validation": `file:${validationTarball}`,
    },
    // Override internal package dependencies so bun resolves them from
    // local tarballs instead of a registry during smoke testing.
    overrides,
  };
}

const defaultSmokeSource = `
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import { ACPClientController, PROTOCOL_VERSION, ndJsonStream } from "@agents-js/acp";
import { validateACPEnvelope } from "@agents-js/validation";

const clientToAgent = new TransformStream();
const agentToClient = new TransformStream();

const clientStream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
const agentStream = ndJsonStream(agentToClient.writable, clientToAgent.readable);

new AgentSideConnection(() => ({
  async initialize() {
    return {
      agentInfo: { name: "consumer-smoke-agent", version: "1.0.0" },
      protocolVersion: PROTOCOL_VERSION,
    };
  },
  async newSession() {
    return { sessionId: "consumer-session" };
  },
  async prompt() {
    return { stopReason: "end_turn" };
  },
}), agentStream);

const controller = new ACPClientController({
  adapters: {
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    sessionUpdate: async () => {},
  },
  dispose: () => {},
  stream: clientStream,
  workspacePolicy: {
    resolveWorkspaceRoot: () => "/workspace",
  },
});

await controller.initialize({
  clientInfo: {
    name: "consumer-smoke",
    version: "0.1.0",
  },
});

await controller.newSession({
  cwd: "/workspace/project",
});

const response = await controller.prompt({
  prompt: [{ type: "text", text: "hello" }],
});

if (response.stopReason !== "end_turn") {
  throw new Error("Expected end_turn stop reason from external consumer smoke test.");
}

const envelope = validateACPEnvelope({
  jsonrpc: "2.0",
  id: "req-1",
  method: "session/new",
  params: { cwd: "/workspace/project" },
});

if (!("method" in envelope) || envelope.method !== "session/new") {
  throw new Error("Expected validation package to accept a valid ACP request envelope.");
}

console.log("external consumer smoke passed");
`;

async function buildHandoffManifest(
  releaseDate: string,
  artifactDir: string,
  acpTarball: string,
  policyTarball: string,
  validationTarball: string,
): Promise<HandoffManifest> {
  const acpStats = await stat(acpTarball);
  const policyStats = await stat(policyTarball);
  const validationStats = await stat(validationTarball);

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
    },
  };
}

export async function runExternalConsumerSmoke(
  options: RunExternalConsumerSmokeOptions = {},
): Promise<RunExternalConsumerSmokeResult> {
  return withExternalConsumerSmokeLock(() => runExternalConsumerSmokeUnlocked(options));
}

async function runExternalConsumerSmokeUnlocked(
  options: RunExternalConsumerSmokeOptions = {},
): Promise<RunExternalConsumerSmokeResult> {
  const releaseDate = options.releaseDate ?? resolveReleaseDate();
  const artifactDir = getArtifactDir(releaseDate);
  const manifestPath = path.join(artifactDir, "acp-rc-manifest.json");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agents-js-acp-consumer-"));
  const buildBackupRoot = path.join(tempDir, "build-output-backups");
  const distSnapshots = await Promise.all([
    snapshotDirectory(path.join(policyPath, "dist"), buildBackupRoot),
    snapshotDirectory(path.join(validationPath, "dist"), buildBackupRoot),
    snapshotDirectory(path.join(acpPath, "dist"), buildBackupRoot),
    snapshotDirectory(path.join(a2uiTypesPath, "dist"), buildBackupRoot),
  ]);

  await ensureArtifactDirDoesNotExist(artifactDir);

  try {
    await buildPackage(policyPath);
    await buildPackage(a2uiTypesPath);
    await buildPackage(validationPath);
    await buildPackage(acpPath);

    const aguiTypesTarball = await packReleaseCandidate(aguiTypesPath, artifactDir);
    const a2uiTypesTarball = await packReleaseCandidate(a2uiTypesPath, artifactDir);
    const acpTarball = await packReleaseCandidate(acpPath, artifactDir);
    const policyTarball = await packReleaseCandidate(policyPath, artifactDir);
    const validationTarball = await packReleaseCandidate(validationPath, artifactDir);
    const packageJson = buildSmokeConsumerPackageJson(
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
      policyTarball,
      validationTarball,
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

    await mkdir(artifactDir, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(handoffManifest, null, 2)}\n`);

    console.log(`ACP RC artifact directory: ${artifactDir}`);
    console.log(`ACP RC tarball: ${acpTarball}`);
    console.log(`Policy RC tarball: ${policyTarball}`);
    console.log(`Validation RC tarball: ${validationTarball}`);
    console.log(`ACP RC manifest: ${manifestPath}`);
    console.log(output.trim());

    return {
      artifactDir,
      acpTarball,
      policyTarball,
      validationTarball,
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
