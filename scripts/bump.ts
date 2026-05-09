#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type DependencyBlockName,
  type PublishablePackageManifest,
  readAllInternalPackages,
  versionManagedInternalDependencyBlocks,
} from "./release-preflight.ts";

const repoRoot = path.resolve(import.meta.dir, "..");
const internalGatewayManifestPath = path.join(repoRoot, "apps", "internal-gateway", "package.json");
const cliManifestPath = path.join(repoRoot, "packages", "cli", "package.json");
const runtimeInstallsPath = path.join(
  repoRoot,
  "packages",
  "gateway-runtime",
  "src",
  "generated-runtime-installs.ts",
);
const claudeAgentPackageName = "@agentclientprotocol/claude-agent-acp";
const codexAgentPackageName = "@zed-industries/codex-acp";

interface VersionsConfig {
  release: string;
  externalSDKs: Record<string, string>;
}

interface CliOptions {
  check: boolean;
}

interface ManagedManifestMismatch {
  actual: string;
  blockName: DependencyBlockName | "version";
  dependencyName?: string;
  manifestName: string;
  manifestPath: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  let check = false;

  for (const arg of argv) {
    switch (arg) {
      case "--check":
        check = true;
        break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument "${arg}".`);
    }
  }

  return { check };
}

function printUsageAndExit(code: number): never {
  console.log(`Usage: bun scripts/bump.ts [options]

Options:
  --check    Verify tracked versions match package.json without writing.
  -h, --help Show this message.
`);
  process.exit(code);
}

async function loadVersionsConfig(): Promise<VersionsConfig> {
  const rootManifestPath = path.join(repoRoot, "package.json");
  const raw = JSON.parse(await readFile(rootManifestPath, "utf8")) as {
    version?: string;
    agentsJs?: { externalSDKs?: Record<string, string> };
  };
  const release = raw.version?.trim();
  const claudeAgentVersion = raw.agentsJs?.externalSDKs?.[claudeAgentPackageName]?.trim();
  const codexAgentVersion = raw.agentsJs?.externalSDKs?.[codexAgentPackageName]?.trim();

  if (!release) {
    throw new Error('package.json is missing a "version" value.');
  }
  if (!claudeAgentVersion) {
    throw new Error(
      `package.json is missing agentsJs.externalSDKs[${JSON.stringify(claudeAgentPackageName)}].`,
    );
  }
  if (!codexAgentVersion) {
    throw new Error(
      `package.json is missing agentsJs.externalSDKs[${JSON.stringify(codexAgentPackageName)}].`,
    );
  }

  return {
    release,
    externalSDKs: {
      [claudeAgentPackageName]: claudeAgentVersion,
      [codexAgentPackageName]: codexAgentVersion,
    },
  };
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function recordManifestMismatches(
  manifestPath: string,
  manifest: PublishablePackageManifest,
  releaseVersion: string,
  knownPackageNames: ReadonlySet<string>,
): ManagedManifestMismatch[] {
  const mismatches: ManagedManifestMismatch[] = [];

  if (manifest.version !== releaseVersion) {
    mismatches.push({
      actual: manifest.version,
      blockName: "version",
      manifestName: manifest.name,
      manifestPath,
    });
  }

  for (const [blockName, dependencyName, spec] of versionManagedInternalDependencyBlocks(
    manifest,
  )) {
    if (!knownPackageNames.has(dependencyName)) {
      continue;
    }
    if (spec !== releaseVersion) {
      mismatches.push({
        actual: spec,
        blockName,
        dependencyName,
        manifestName: manifest.name,
        manifestPath,
      });
    }
  }

  return mismatches;
}

function renderRuntimeInstallsSource(
  claudeExpectedVersion: string,
  codexExpectedVersion: string,
): string {
  return `/**
 * Generated from the root \`package.json\` (\`agentsJs.externalSDKs\`) by \`scripts/bump.ts\`.
 * Do not edit manually.
 */

export const EXTERNAL_RUNTIME_INSTALL_VERSIONS = Object.freeze({
  "${claudeAgentPackageName}": "${claudeExpectedVersion}",
  "${codexAgentPackageName}": "${codexExpectedVersion}",
} as const);

export const CLAUDE_AGENT_ACP_PACKAGE_NAME = "${claudeAgentPackageName}";
export const CLAUDE_AGENT_ACP_VERSION =
  EXTERNAL_RUNTIME_INSTALL_VERSIONS[CLAUDE_AGENT_ACP_PACKAGE_NAME];

export const CODEX_ACP_PACKAGE_NAME = "${codexAgentPackageName}";
export const CODEX_ACP_VERSION = EXTERNAL_RUNTIME_INSTALL_VERSIONS[CODEX_ACP_PACKAGE_NAME];
`;
}

async function updateManifestVersion(
  manifestPath: string,
  dependencyName: string,
  expectedVersion: string,
  check: boolean,
  changedFiles: Set<string>,
  issues: string[],
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PublishablePackageManifest;
  const currentVersion = manifest.dependencies?.[dependencyName];
  if (currentVersion === undefined) {
    throw new Error(
      `${path.relative(repoRoot, manifestPath)} is missing dependencies.${dependencyName}.`,
    );
  }

  if (currentVersion !== expectedVersion) {
    if (check) {
      issues.push(
        `${path.relative(repoRoot, manifestPath)}: dependencies.${dependencyName}=${currentVersion} does not match ${expectedVersion}`,
      );
    }
  }

  if (check || currentVersion === expectedVersion) {
    return;
  }

  if (!manifest.dependencies) {
    throw new Error(`${path.relative(repoRoot, manifestPath)} is missing dependencies.`);
  }
  manifest.dependencies[dependencyName] = expectedVersion;
  await writeFile(manifestPath, formatJson(manifest));
  changedFiles.add(path.relative(repoRoot, manifestPath));
}

async function updateRuntimeVersion(
  claudeExpectedVersion: string,
  codexExpectedVersion: string,
  check: boolean,
  changedFiles: Set<string>,
  issues: string[],
): Promise<void> {
  const nextSource = renderRuntimeInstallsSource(claudeExpectedVersion, codexExpectedVersion);
  const currentSource = await readFile(runtimeInstallsPath, "utf8");
  if (currentSource === nextSource) {
    return;
  }

  if (check) {
    issues.push(
      `${path.relative(repoRoot, runtimeInstallsPath)}: generated external ACP runtime install versions do not match package.json agentsJs.externalSDKs (claude=${claudeExpectedVersion}, codex=${codexExpectedVersion})`,
    );
  }

  if (check) {
    return;
  }

  await writeFile(runtimeInstallsPath, nextSource);
  changedFiles.add(path.relative(repoRoot, runtimeInstallsPath));
}

async function runBunInstall(): Promise<void> {
  const proc = Bun.spawn(["bun", "install"], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`bun install failed with exit code ${exitCode}.`);
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    printUsageAndExit(2);
  }

  const config = await loadVersionsConfig();
  const changedFiles = new Set<string>();
  const issues: string[] = [];
  const internalPackages = await readAllInternalPackages(repoRoot);
  const knownPackageNames = new Set(internalPackages.map((pkg) => pkg.manifest.name));

  for (const pkg of internalPackages) {
    const mismatches = recordManifestMismatches(
      pkg.manifestPath,
      pkg.manifest,
      config.release,
      knownPackageNames,
    );
    if (options.check) {
      for (const mismatch of mismatches) {
        if (mismatch.blockName === "version") {
          issues.push(
            `${path.relative(repoRoot, mismatch.manifestPath)}: version=${mismatch.actual} does not match ${config.release}`,
          );
        } else {
          issues.push(
            `${path.relative(repoRoot, mismatch.manifestPath)}: ${mismatch.blockName}.${mismatch.dependencyName}=${mismatch.actual} does not match ${config.release}`,
          );
        }
      }
    }

    if (options.check || mismatches.length === 0) {
      continue;
    }

    const nextManifest = structuredClone(pkg.manifest);
    nextManifest.version = config.release;
    for (const [blockName, dependencyName] of versionManagedInternalDependencyBlocks(
      nextManifest,
    )) {
      if (!knownPackageNames.has(dependencyName)) {
        continue;
      }
      const block = nextManifest[blockName];
      if (!block) {
        continue;
      }
      block[dependencyName] = config.release;
    }

    await writeFile(pkg.manifestPath, formatJson(nextManifest));
    changedFiles.add(path.relative(repoRoot, pkg.manifestPath));
  }

  const claudeAgentVersion = config.externalSDKs[claudeAgentPackageName];
  const codexAgentVersion = config.externalSDKs[codexAgentPackageName];
  await updateManifestVersion(
    internalGatewayManifestPath,
    claudeAgentPackageName,
    claudeAgentVersion,
    options.check,
    changedFiles,
    issues,
  );
  await updateManifestVersion(
    internalGatewayManifestPath,
    codexAgentPackageName,
    codexAgentVersion,
    options.check,
    changedFiles,
    issues,
  );
  await updateManifestVersion(
    cliManifestPath,
    claudeAgentPackageName,
    claudeAgentVersion,
    options.check,
    changedFiles,
    issues,
  );
  await updateManifestVersion(
    cliManifestPath,
    codexAgentPackageName,
    codexAgentVersion,
    options.check,
    changedFiles,
    issues,
  );
  await updateRuntimeVersion(
    claudeAgentVersion,
    codexAgentVersion,
    options.check,
    changedFiles,
    issues,
  );

  if (issues.length > 0) {
    console.error("[bump] FAIL");
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    process.exit(1);
  }

  if (options.check) {
    console.log("[bump] OK");
    console.log("- all tracked version surfaces match package.json");
    return;
  }

  if (changedFiles.size > 0) {
    console.log("[bump] updated tracked files:");
    for (const changedFile of [...changedFiles].sort()) {
      console.log(`- ${changedFile}`);
    }
  } else {
    console.log("[bump] no tracked file changes were needed");
  }

  if (changedFiles.size === 0) {
    console.log("[bump] OK");
    return;
  }

  await runBunInstall();
  console.log("[bump] OK");
}

if (import.meta.main) {
  await main();
}
