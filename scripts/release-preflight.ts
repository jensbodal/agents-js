#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  EXPECTED_PUBLISH_ACCESS,
  PUBLISH_REGISTRY_ENV,
  PUBLISH_SCOPE,
  publishPackageName,
  resolvePublishRegistry,
} from "./release-config.ts";

const repoRoot = path.resolve(import.meta.dir, "..");

export type DependencyBlockName =
  | "dependencies"
  | "peerDependencies"
  | "optionalDependencies"
  | "devDependencies";

type DependencyMap = Record<string, string> | undefined;

export interface PublishablePackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  publishConfig?: {
    access?: string;
    registry?: string;
  };
  version: string;
}

export interface AuditedPackage {
  dirName: string;
  manifest: PublishablePackageManifest;
  manifestPath: string;
}

export type PublishPackageDirName = string;

export interface ReleaseAuditOptions {
  repoRoot?: string;
  requireNpmrc?: boolean;
}

export interface ReleaseAuditResult {
  issues: string[];
  packages: AuditedPackage[];
  publishOrder: PublishPackageDirName[];
  publishRegistry: string | null;
  releaseVersion: string | null;
  scopedRegistry: string | null;
}

interface CliOptions {
  json: boolean;
  requireNpmrc: boolean;
}

interface VersionsConfig {
  release: string;
  externalSDKs: Record<string, string>;
}

const claudeAgentPackageName = "@zed-industries/claude-agent-acp";
const codexAgentPackageName = "@zed-industries/codex-acp";
const claudeRuntimeInstallPattern = /"@zed-industries\/claude-agent-acp":\s*"([^"]+)"/g;
const codexRuntimeInstallPattern = /"@zed-industries\/codex-acp":\s*"([^"]+)"/g;

function normalizeRegistry(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function trimText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function dependencyEntries(
  manifest: PublishablePackageManifest,
  blockName: DependencyBlockName,
): Array<[string, string]> {
  return Object.entries((manifest[blockName] as DependencyMap) ?? {});
}

function internalDependencyBlocks(
  manifest: PublishablePackageManifest,
): Array<[DependencyBlockName, string, string]> {
  return (["dependencies", "peerDependencies", "optionalDependencies"] as const).flatMap(
    (blockName) =>
      dependencyEntries(manifest, blockName)
        .filter(([depName]) => depName.startsWith(`${PUBLISH_SCOPE}/`))
        .map(([depName, spec]) => [blockName, depName, spec] as const),
  );
}

export function versionManagedInternalDependencyBlocks(
  manifest: PublishablePackageManifest,
): Array<[DependencyBlockName, string, string]> {
  return (
    ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const
  ).flatMap((blockName) =>
    dependencyEntries(manifest, blockName)
      .filter(([depName]) => depName.startsWith(`${PUBLISH_SCOPE}/`))
      .map(([depName, spec]) => [blockName, depName, spec] as const),
  );
}

export function parseScopedRegistryFromNpmrc(
  contents: string,
  scope = PUBLISH_SCOPE,
): string | null {
  const prefix = `${scope}:registry=`;
  let scopedRegistry: string | null = null;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith(prefix)) {
      scopedRegistry = normalizeRegistry(line.slice(prefix.length).trim());
    }
  }

  return scopedRegistry;
}

export function collectInternalDependencyIssues(
  pkg: AuditedPackage,
  releaseVersion: string,
  knownPackageNames: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];

  for (const [blockName, dependencyName, spec] of versionManagedInternalDependencyBlocks(
    pkg.manifest,
  )) {
    if (!knownPackageNames.has(dependencyName)) {
      issues.push(
        `${pkg.manifest.name}: ${blockName}.${dependencyName} references an unknown internal package (${spec})`,
      );
      continue;
    }

    if (spec.startsWith("workspace:") || spec.startsWith("file:")) {
      issues.push(
        `${pkg.manifest.name}: ${blockName}.${dependencyName} uses ${spec}; publishable packages must use exact released versions`,
      );
      continue;
    }

    if (spec !== releaseVersion) {
      issues.push(
        `${pkg.manifest.name}: ${blockName}.${dependencyName}=${spec} does not match release version ${releaseVersion}`,
      );
    }
  }

  return issues;
}

export function collectPublishOrderIssues(packages: AuditedPackage[]): string[] {
  try {
    computePublishOrder(packages);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function computePublishOrder(packages: AuditedPackage[]): PublishPackageDirName[] {
  const nameToDirName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg.dirName]));
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const pkg of packages) {
    dependents.set(pkg.dirName, new Set());
    indegree.set(pkg.dirName, 0);
  }

  for (const pkg of packages) {
    for (const [, dependencyName] of internalDependencyBlocks(pkg.manifest)) {
      const dependencyDirName = nameToDirName.get(dependencyName);
      if (!dependencyDirName || dependencyDirName === pkg.dirName) {
        continue;
      }

      const packageDependents = dependents.get(dependencyDirName);
      if (!packageDependents || packageDependents.has(pkg.dirName)) {
        continue;
      }

      packageDependents.add(pkg.dirName);
      indegree.set(pkg.dirName, (indegree.get(pkg.dirName) ?? 0) + 1);
    }
  }

  const ready = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([dirName]) => dirName)
    .sort();
  const order: PublishPackageDirName[] = [];

  while (ready.length > 0) {
    const dirName = ready.shift();
    if (!dirName) {
      break;
    }
    order.push(dirName);

    const downstream = [...(dependents.get(dirName) ?? [])].sort();
    for (const dependent of downstream) {
      const nextDegree = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== packages.length) {
    const unresolved = packages
      .map((pkg) => pkg.dirName)
      .filter((dirName) => !order.includes(dirName))
      .sort();
    throw new Error(
      `Publish order contains a dependency cycle among publishable package directories: ${unresolved.join(", ")}`,
    );
  }

  return order;
}

export async function readPublishablePackages(rootDir: string): Promise<AuditedPackage[]> {
  const scopes = ["packages", "extras"] as const;
  const collected = await Promise.all(
    scopes.map(async (scope) => {
      const scopeDir = path.join(rootDir, scope);
      const dirs = await readdir(scopeDir, { withFileTypes: true });
      const audited = await Promise.all(
        dirs
          .filter((entry) => entry.isDirectory())
          .map(async (entry): Promise<AuditedPackage | undefined> => {
            const manifestPath = path.join(scopeDir, entry.name, "package.json");
            // Skip directories that are not actual packages — relocations leave
            // behind empty parent dirs (just node_modules / dist caches) that
            // readdir surfaces but readFile on package.json would error on.
            try {
              const manifest = JSON.parse(
                await readFile(manifestPath, "utf8"),
              ) as PublishablePackageManifest;
              return {
                dirName: entry.name,
                manifest,
                manifestPath,
              } satisfies AuditedPackage;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return undefined;
              }
              throw error;
            }
          }),
      );
      return audited.filter((pkg): pkg is AuditedPackage => pkg !== undefined);
    }),
  );

  return collected.flat().filter((pkg) => pkg.manifest.private !== true);
}

async function loadVersionsConfig(rootDir: string): Promise<VersionsConfig> {
  const raw = JSON.parse(
    await readFile(path.join(rootDir, ".versions.json"), "utf8"),
  ) as Partial<VersionsConfig>;
  const release = raw.release?.trim();
  const claudeAgentVersion = raw.externalSDKs?.[claudeAgentPackageName]?.trim();
  const codexAgentVersion = raw.externalSDKs?.[codexAgentPackageName]?.trim();

  if (!release) {
    throw new Error(`.versions.json is missing a non-empty "release" value.`);
  }
  if (!claudeAgentVersion) {
    throw new Error(
      `.versions.json is missing externalSDKs.${JSON.stringify(claudeAgentPackageName)}.`,
    );
  }
  if (!codexAgentVersion) {
    throw new Error(
      `.versions.json is missing externalSDKs.${JSON.stringify(codexAgentPackageName)}.`,
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

function collectConfiguredVersionIssues(
  pkg: AuditedPackage,
  configuredReleaseVersion: string,
  knownPackageNames: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];

  if (pkg.manifest.version !== configuredReleaseVersion) {
    issues.push(
      `${pkg.manifestPath}: version=${pkg.manifest.version} does not match .versions.json release ${configuredReleaseVersion}`,
    );
  }

  for (const [blockName, dependencyName, spec] of versionManagedInternalDependencyBlocks(
    pkg.manifest,
  )) {
    if (!knownPackageNames.has(dependencyName)) {
      continue;
    }
    if (spec !== configuredReleaseVersion) {
      issues.push(
        `${pkg.manifest.name}: ${blockName}.${dependencyName}=${spec} does not match .versions.json release ${configuredReleaseVersion}`,
      );
    }
  }

  return issues;
}

async function collectExternalSdkVersionIssues(
  rootDir: string,
  config: VersionsConfig,
): Promise<string[]> {
  const issues: string[] = [];
  const packageNames = [claudeAgentPackageName, codexAgentPackageName] as const;
  const manifestTargets = [
    path.join(rootDir, "apps", "internal-gateway", "package.json"),
    path.join(rootDir, "packages", "cli", "package.json"),
  ] as const;

  for (const manifestPath of manifestTargets) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PublishablePackageManifest;
    for (const packageName of packageNames) {
      const expectedVersion = config.externalSDKs[packageName];
      const actualVersion = manifest.dependencies?.[packageName];
      if (actualVersion === undefined) {
        issues.push(`${path.relative(rootDir, manifestPath)}: missing dependencies.${packageName}`);
        continue;
      }
      if (actualVersion !== expectedVersion) {
        issues.push(
          `${path.relative(rootDir, manifestPath)}: dependencies.${packageName}=${actualVersion} does not match .versions.json externalSDKs.${JSON.stringify(packageName)}=${expectedVersion}`,
        );
      }
    }
  }

  const runtimePath = path.join(
    rootDir,
    "packages",
    "gateway-runtime",
    "src",
    "generated-runtime-installs.ts",
  );
  const runtimeSource = await readFile(runtimePath, "utf8");
  for (const [packageName, pattern, label] of [
    [claudeAgentPackageName, claudeRuntimeInstallPattern, "Claude"],
    [codexAgentPackageName, codexRuntimeInstallPattern, "Codex"],
  ] as const) {
    const expectedVersion = config.externalSDKs[packageName];
    const matches = [...runtimeSource.matchAll(pattern)];
    if (matches.length !== 1) {
      issues.push(
        `${path.relative(rootDir, runtimePath)}: expected exactly one generated ${label} runtime install target, found ${matches.length}`,
      );
      continue;
    }

    const actualVersion = matches[0]?.[1];
    if (actualVersion !== expectedVersion) {
      issues.push(
        `${path.relative(rootDir, runtimePath)}: ${label} runtime version=${actualVersion} does not match .versions.json externalSDKs.${JSON.stringify(packageName)}=${expectedVersion}`,
      );
    }
  }

  return issues;
}

async function readScopedRegistryFromRepoNpmrc(rootDir: string): Promise<string | null> {
  const npmrcPath = path.join(rootDir, ".npmrc");
  try {
    const contents = await readFile(npmrcPath, "utf8");
    return parseScopedRegistryFromNpmrc(contents);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 *  Release-readiness defaults audit
 *  -------------------------------------------------------------------------
 *  Source-level regression guards for the security/UX defaults established
 *  during the release-readiness work. Any regression here is a fail of the
 *  preflight: silent re-introduction of a global secret baseline, of
 *  `setPermissionMode("yolo")` for dispatch, etc., is a release stopper.
 *
 *  These checks are intentionally string/source-level rather than runtime —
 *  they catch regressions even when no test exercises the path, and they
 *  fail fast with a single grep per concern.
 * ------------------------------------------------------------------------ */

interface SourceCheck {
  /** Short name printed in the issue list. */
  name: string;
  /** Path relative to the repo root. */
  filePath: string;
  /**
   * Returns an issue message when the source regresses, or `null` when the
   * file looks correct. The function receives the file's full text.
   */
  validate(contents: string): string | null;
}

export const RELEASE_READINESS_CHECKS: readonly SourceCheck[] = [
  {
    name: "no global baseline secret keys",
    filePath: "packages/host/src/runtime-env-policy.ts",
    validate: (contents) => {
      if (
        !/BASELINE_AGENT_SECRET_ENV_KEYS:\s*readonly\s+string\[\]\s*=\s*Object\.freeze\(\[\]\)/.test(
          contents,
        )
      ) {
        return "BASELINE_AGENT_SECRET_ENV_KEYS must be Object.freeze([]) — global secret forwarding has regressed";
      }
      return null;
    },
  },
  {
    name: "--registry-sync flag exists",
    filePath: "packages/cli/src/shared-arg-specs.ts",
    validate: (contents) => {
      if (!/"--registry-sync"\s*:\s*\{/.test(contents)) {
        return "shared-arg-specs.ts must declare a --registry-sync flag";
      }
      return null;
    },
  },
  {
    name: "registry sync gate respects only literal 'true'",
    filePath: "packages/cli/src/serve.ts",
    validate: (contents) => {
      if (!/AGENTS_JS_REGISTRY_SYNC\s*===\s*"true"/.test(contents)) {
        return 'serve.ts must compare AGENTS_JS_REGISTRY_SYNC === "true" — ambiguous truthy parsing has regressed';
      }
      return null;
    },
  },
  {
    name: "--trust-workspace flag exists",
    filePath: "apps/internal-gateway/cli-args.ts",
    validate: (contents) => {
      if (!/"--trust-workspace"/.test(contents)) {
        return "internal-gateway/cli-args.ts must declare --trust-workspace";
      }
      if (!/AGENTS_JS_TRUST_WORKSPACE\s*===\s*"true"/.test(contents)) {
        return 'cli-args.ts must compare AGENTS_JS_TRUST_WORKSPACE === "true"';
      }
      return null;
    },
  },
  {
    name: "@@dispatch does not hard-code yolo and publishes cancelable=false",
    filePath: "packages/host/src/host-executor.ts",
    validate: (contents) => {
      if (/setPermissionMode\(\s*"yolo"\s*\)/.test(contents)) {
        return 'host-executor.ts contains setPermissionMode("yolo") — dispatch must inherit gateway policy instead';
      }
      if (!/agents-js\.cancelable/.test(contents)) {
        return "host-executor.ts must publish agents-js.cancelable metadata for dispatch tasks";
      }
      return null;
    },
  },
  {
    name: "AG-UI run coordinator module exists",
    filePath: "packages/host/src/agui-run-coordinator.ts",
    validate: (contents) => {
      if (!/export\s+class\s+AguiRunCoordinator/.test(contents)) {
        return "agui-run-coordinator.ts must export AguiRunCoordinator";
      }
      if (!/export\s+class\s+AguiRunBusyError/.test(contents)) {
        return "agui-run-coordinator.ts must export AguiRunBusyError";
      }
      return null;
    },
  },
  {
    name: "AG-UI disconnect cancels controller",
    filePath: "packages/host/src/agui-run-session.ts",
    validate: (contents) => {
      if (!/run canceled by disconnect/.test(contents)) {
        return 'agui-run-session.ts must emit RUN_ERROR with "run canceled by disconnect" on abort';
      }
      if (!/controller\.cancel\?\.\(\)/.test(contents)) {
        return "agui-run-session.ts must call controller.cancel() on abort";
      }
      return null;
    },
  },
  {
    name: "A2UI back-channel reaches the WS bridge",
    filePath: "apps/web-ui/src/main.ts",
    validate: (contents) => {
      if (!/_hostClient\.sendSurfaceEvent/.test(contents)) {
        return "apps/web-ui/src/main.ts must route A2UI surface events through hostClient.sendSurfaceEvent";
      }
      return null;
    },
  },
  {
    name: "WS bridge accepts surface_event frame",
    filePath: "packages/host/src/ws-bridge.ts",
    validate: (contents) => {
      if (!/case\s+"surface_event"/.test(contents)) {
        return "ws-bridge.ts must handle surface_event client message";
      }
      return null;
    },
  },
  {
    name: "audit module forbids sensitive payload keys",
    filePath: "packages/host/src/audit.ts",
    validate: (contents) => {
      if (!/_NoSensitivePayload/.test(contents)) {
        return "audit.ts must include the _NoSensitivePayload type-system guard";
      }
      // The set must reference all four forbidden keys. Order does not
      // matter; we just check each appears within the type alias.
      const slice = contents.slice(contents.indexOf("_NoSensitivePayload"));
      for (const key of ["prompt", "env", "args", "payload"]) {
        if (!new RegExp(`"${key}"`).test(slice)) {
          return `audit.ts _NoSensitivePayload must list "${key}" as a forbidden key`;
        }
      }
      return null;
    },
  },
];

export async function auditReleaseReadinessDefaults(rootDir: string): Promise<string[]> {
  const issues: string[] = [];
  for (const check of RELEASE_READINESS_CHECKS) {
    const fullPath = path.join(rootDir, check.filePath);
    let contents: string;
    try {
      contents = await readFile(fullPath, "utf8");
    } catch (err) {
      issues.push(
        `release-readiness: cannot read ${check.filePath} for "${check.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    const issue = check.validate(contents);
    if (issue !== null) {
      issues.push(`release-readiness [${check.name}]: ${issue}`);
    }
  }
  return issues;
}

export async function auditReleaseSurface(
  options: ReleaseAuditOptions = {},
): Promise<ReleaseAuditResult> {
  const rootDir = options.repoRoot ?? repoRoot;
  const requireNpmrc = options.requireNpmrc ?? true;
  const packages = await readPublishablePackages(rootDir);
  const issues: string[] = [];
  const config = await loadVersionsConfig(rootDir);
  const publishOrderIssues = collectPublishOrderIssues(packages);
  const publishOrder = publishOrderIssues.length === 0 ? computePublishOrder(packages) : [];

  if (packages.length === 0) {
    issues.push("No publishable packages were found under packages/ or extras/.");
  }

  const versions = [...new Set(packages.map((pkg) => pkg.manifest.version))].sort();
  const releaseVersion = versions.length === 1 ? versions[0] : null;
  if (versions.length > 1) {
    issues.push(`Publishable packages do not share one version: ${versions.join(", ")}`);
  }

  const knownPackageNames = new Set(packages.map((pkg) => pkg.manifest.name));
  issues.push(...publishOrderIssues);

  for (const pkg of packages) {
    const expectedName = publishPackageName(pkg.dirName);
    if (pkg.manifest.name !== expectedName) {
      issues.push(
        `${pkg.manifestPath}: expected package name ${expectedName}, found ${pkg.manifest.name}`,
      );
    }

    const registry = trimText(pkg.manifest.publishConfig?.registry);
    if (registry !== null) {
      // Belt-and-suspenders OSS safety: package.json must never leak a registry
      // hostname. The registry is supplied by the publisher via the
      // AGENTS_JS_PUBLISH_REGISTRY env var and passed to `npm publish
      // --registry` explicitly.
      issues.push(
        `${pkg.manifest.name}: publishConfig.registry=${registry} must not be set in package.json; registry is supplied via ${PUBLISH_REGISTRY_ENV}`,
      );
    }

    const accessValue = trimText(pkg.manifest.publishConfig?.access);
    if (accessValue !== EXPECTED_PUBLISH_ACCESS) {
      issues.push(
        `${pkg.manifest.name}: publishConfig.access=${accessValue ?? "(missing)"} does not match ${EXPECTED_PUBLISH_ACCESS}`,
      );
    }

    if (releaseVersion) {
      issues.push(...collectInternalDependencyIssues(pkg, releaseVersion, knownPackageNames));
    }
    issues.push(...collectConfiguredVersionIssues(pkg, config.release, knownPackageNames));
  }

  // The committed repo-root .npmrc must NOT pin the @agents-js scope to a
  // specific registry hostname — that would re-leak the internal registry URL
  // any time the repo is published as OSS. Publishers configure the scoped
  // registry in an uncommitted location (CI secret writing a local .npmrc, or
  // the user's `~/.npmrc`) and point the publish scripts at it via
  // AGENTS_JS_PUBLISH_REGISTRY.
  const scopedRegistry = await readScopedRegistryFromRepoNpmrc(rootDir);
  if (scopedRegistry !== null) {
    issues.push(
      `.npmrc pins ${PUBLISH_SCOPE} to ${scopedRegistry}; remove the scoped registry line from the committed .npmrc`,
    );
  }

  const publishRegistry = resolvePublishRegistry();
  if (requireNpmrc && publishRegistry === null) {
    issues.push(
      `${PUBLISH_REGISTRY_ENV} is not set; export the target npm registry URL before publishing`,
    );
  }

  issues.push(...(await collectExternalSdkVersionIssues(rootDir, config)));
  issues.push(...(await auditReleaseReadinessDefaults(rootDir)));

  return {
    issues: issues.sort(),
    packages,
    publishOrder,
    publishRegistry,
    releaseVersion,
    scopedRegistry,
  };
}

function parseCliArgs(argv: string[]): CliOptions {
  let json = false;
  // Publish-time prerequisites (the AGENTS_JS_PUBLISH_REGISTRY env var)
  // are opt-in for the CLI. Dev `check` runs preflight purely as a static
  // audit of the repo state; only the publisher (publish-all.ts, or a
  // release operator running preflight explicitly) needs to enforce the
  // publish-target env var.
  let requireNpmrc = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--json":
        json = true;
        break;
      case "--require-publish-env":
        requireNpmrc = true;
        break;
      case "--allow-missing-npmrc":
        // Back-compat alias: the new model has no committed-.npmrc
        // requirement, but accept the old flag as a no-op so existing docs
        // and scripts keep working.
        requireNpmrc = false;
        break;
      case "--help":
      case "-h":
        printUsageAndExit(0);
        break;
      default:
        throw new Error(`Unknown argument "${arg}".`);
    }
  }

  return { json, requireNpmrc };
}

function printUsageAndExit(code: number): never {
  console.log(`Usage: bun scripts/release-preflight.ts [options]

Options:
  --json                   Print the audit result as JSON.
  --require-publish-env    Also require ${PUBLISH_REGISTRY_ENV} to be set.
  --allow-missing-npmrc    Deprecated; retained as a no-op for back-compat.
  -h, --help               Show this message.
`);
  process.exit(code);
}

function printHumanSummary(result: ReleaseAuditResult): void {
  if (result.issues.length > 0) {
    console.error("[release:preflight] FAIL");
    for (const issue of result.issues) {
      console.error(`- ${issue}`);
    }
    return;
  }

  console.log("[release:preflight] OK");
  console.log(
    `- ${result.packages.length} publishable packages at ${result.releaseVersion ?? "(unknown version)"}`,
  );
  console.log(
    `- publish registry: ${result.publishRegistry ?? `(unset; export ${PUBLISH_REGISTRY_ENV} before publish)`}`,
  );
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliArgs(Bun.argv.slice(2));
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    printUsageAndExit(2);
  }

  const result = await auditReleaseSurface({ requireNpmrc: options.requireNpmrc });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHumanSummary(result);
  }

  if (result.issues.length > 0) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
