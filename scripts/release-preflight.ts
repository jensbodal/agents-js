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

const claudeAgentPackageName = "@agentclientprotocol/claude-agent-acp";
const codexAgentPackageName = "@zed-industries/codex-acp";
const claudeRuntimeInstallPattern = /"@agentclientprotocol\/claude-agent-acp":\s*"([^"]+)"/g;
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

export async function readAllInternalPackages(rootDir: string): Promise<AuditedPackage[]> {
  const scopes = ["packages", "extras", "tests"] as const;
  const collected = await Promise.all(
    scopes.map(async (scope) => {
      const scopeDir = path.join(rootDir, scope);
      const dirs = await readdir(scopeDir, { withFileTypes: true });
      const audited = await Promise.all(
        dirs
          .filter((entry) => entry.isDirectory())
          .map(async (entry): Promise<AuditedPackage | undefined> => {
            const manifestPath = path.join(scopeDir, entry.name, "package.json");
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

  return collected.flat().filter((pkg) => pkg.manifest.name?.startsWith(`${PUBLISH_SCOPE}/`));
}

async function loadVersionsConfig(rootDir: string): Promise<VersionsConfig> {
  const rootManifestPath = path.join(rootDir, "package.json");
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

function collectConfiguredVersionIssues(
  pkg: AuditedPackage,
  configuredReleaseVersion: string,
  knownPackageNames: ReadonlySet<string>,
): string[] {
  const issues: string[] = [];

  if (pkg.manifest.version !== configuredReleaseVersion) {
    issues.push(
      `${pkg.manifestPath}: version=${pkg.manifest.version} does not match package.json release ${configuredReleaseVersion}`,
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
        `${pkg.manifest.name}: ${blockName}.${dependencyName}=${spec} does not match package.json release ${configuredReleaseVersion}`,
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
          `${path.relative(rootDir, manifestPath)}: dependencies.${packageName}=${actualVersion} does not match package.json agentsJs.externalSDKs.${JSON.stringify(packageName)}=${expectedVersion}`,
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
        `${path.relative(rootDir, runtimePath)}: ${label} runtime version=${actualVersion} does not match package.json agentsJs.externalSDKs.${JSON.stringify(packageName)}=${expectedVersion}`,
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

const releaseGapLanguagePattern =
  /\b(deferred|follow-up|not yet|not wired|future feature|planned|later)\b/i;

const RELEASE_GAP_LANGUAGE_SCAN_PATHS = [
  "apps/web-ui/src/a2ui-demo.ts",
  "apps/web-ui/src/main.ts",
  "docs/architecture.md",
  "docs/develop/playground-smoke.md",
  "docs/observability.md",
  "docs/protocols.md",
  "docs/streaming-and-events.md",
  "docs/surfaces.md",
  "packages/a2a-client/src/sync.ts",
  "packages/a2ui-renderer/src/acp-bindings.ts",
  "packages/gateway-runtime/src/resolve-and-apply.ts",
  "packages/host/src/agui-endpoint.ts",
  "packages/host/src/agui-run-coordinator.ts",
  "packages/host/src/host-executor.ts",
  "packages/host/src/surface-broadcaster.ts",
  "packages/tools/src/trace.ts",
  "scripts/build-dashboard.ts",
  "scripts/check-docs-playground.ts",
  "scripts/dashboard-status.json",
] as const;

async function collectReleaseGapLanguageIssues(rootDir: string): Promise<string[]> {
  const issues: string[] = [];
  for (const relPath of RELEASE_GAP_LANGUAGE_SCAN_PATHS) {
    const contents = await readFile(path.join(rootDir, relPath), "utf8");
    const lines = contents.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = releaseGapLanguagePattern.exec(line);
      if (match) {
        issues.push(
          `release-readiness [no release-gap wording]: ${relPath}:${index + 1} contains "${match[0]}"`,
        );
      }
    }
  }
  return issues;
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
    name: "internal gateway registry sync is gated by --registry-sync",
    filePath: "apps/internal-gateway/cli-args.ts",
    validate: (contents) => {
      if (!/"--registry-sync"/.test(contents)) {
        return "internal-gateway/cli-args.ts must declare --registry-sync";
      }
      if (!/AGENTS_JS_REGISTRY_SYNC\s*===\s*"true"/.test(contents)) {
        return 'internal-gateway/cli-args.ts must compare AGENTS_JS_REGISTRY_SYNC === "true"';
      }
      if (!/registrySync:\s*boolean/.test(contents)) {
        return "GatewayCliArgs must expose a registrySync boolean field";
      }
      return null;
    },
  },
  {
    name: "internal gateway does NOT call startRegistrySync unconditionally",
    filePath: "apps/internal-gateway/main.ts",
    validate: (contents) => {
      // Both call sites must be gated on cliArgs.registrySync. Without
      // the gate, the well-known sync endpoint is mounted on every
      // gateway startup and the periodic peer fetcher runs even
      // though sync is meant to be opt-in.
      if (!/opts\.cliArgs\.registrySync\s*\?\s*createSyncEndpointHandler/.test(contents)) {
        return "main.ts must gate createSyncEndpointHandler() on opts.cliArgs.registrySync";
      }
      if (!/if\s*\(opts\.cliArgs\.registrySync\)/.test(contents)) {
        return "main.ts must gate startRegistrySync() inside an `if (opts.cliArgs.registrySync)` block";
      }
      // When sync is disabled, autoRegister must still run so the
      // local machine still discovers the gateway. The opt-out path
      // must not collapse to "no registration at all".
      if (!/void\s+autoRegister\(/.test(contents)) {
        return "main.ts must call autoRegister() in the registry-sync-disabled branch";
      }
      return null;
    },
  },
  {
    name: "ACP @@dispatch is non-interactive (cancels on permission/write-gate/elicitation)",
    filePath: "packages/host/src/host-executor.ts",
    validate: (contents) => {
      // The subscription helper must call cancel on each of the three
      // event kinds. The literal `cancelDispatchController` name plus
      // its three call sites is the cheapest way to verify this
      // without parsing the AST.
      if (!/cancelDispatchController/.test(contents)) {
        return "host-executor.ts must define cancelDispatchController and invoke it on permission/write-gate/elicitation events";
      }
      const occurrences = contents.match(/cancelDispatchController\(\)/g) ?? [];
      if (occurrences.length < 3) {
        return `host-executor.ts must invoke cancelDispatchController() on all three non-interactive events; found ${occurrences.length}`;
      }
      return null;
    },
  },
  {
    name: "runtime switch rejects active work",
    filePath: "apps/internal-gateway/main.ts",
    validate: (contents) => {
      if (!/describeRuntimeSwitchBlockingActivity/.test(contents)) {
        return "main.ts must use describeRuntimeSwitchBlockingActivity to gate runtime switches";
      }
      if (!/Runtime switch rejected:/.test(contents)) {
        return 'main.ts must throw an explicit "Runtime switch rejected:" error when blocking activity exists';
      }
      if (!/destroyIdleLanes\(\)/.test(contents)) {
        return "main.ts must call executor.destroyIdleLanes() after a successful runtime switch";
      }
      return null;
    },
  },
  {
    name: "AG-UI endpoint honors RunAgentInput.runId",
    filePath: "packages/host/src/agui-endpoint.ts",
    validate: (contents) => {
      // The endpoint must check input.runId before falling back to a
      // server-generated UUID. Catching this requires looking for the
      // ternary that selects between input.runId and crypto.randomUUID()
      // — not just the bare crypto.randomUUID() call (the threadId
      // fallback uses one too).
      if (!/input\.runId/.test(contents)) {
        return "agui-endpoint.ts must read input.runId from the validated RunAgentInput";
      }
      if (!/typeof input\.runId === "string"/.test(contents)) {
        return "agui-endpoint.ts must guard input.runId with a typeof check before using it";
      }
      return null;
    },
  },
  {
    name: "AG-UI endpoint rejects non-text user content",
    filePath: "packages/host/src/agui-endpoint.ts",
    validate: (contents) => {
      if (!/Unsupported user message content/.test(contents)) {
        return "agui-endpoint.ts must reject non-text user message content with a clear 400";
      }
      if (!/POST \/agent accepts text user messages only/.test(contents)) {
        return "agui-endpoint.ts must state the text-only /agent contract in the rejection body";
      }
      return null;
    },
  },
  {
    name: "audit union includes emitted registry and mention events",
    filePath: "packages/a2a/src/audit.ts",
    validate: (contents) => {
      for (const variant of [
        '"registry-sync-served"',
        '"registry-sync-fetched"',
        '"registry-sync-merged"',
        '"mention-dispatch-started"',
        '"mention-dispatch-succeeded"',
        '"mention-dispatch-failed"',
        '"mention-dispatch-unknown"',
        '"mention-dispatch-blocked"',
      ]) {
        if (!contents.includes(variant)) {
          return `audit.ts must declare ${variant} because source emits that structural audit event`;
        }
      }
      return null;
    },
  },
  {
    name: "registry sync emits served fetched and merged audit records",
    filePath: "packages/a2a-client/src/sync.ts",
    validate: (contents) => {
      for (const variant of [
        '"registry-sync-served"',
        '"registry-sync-fetched"',
        '"registry-sync-merged"',
      ]) {
        if (!contents.includes(variant)) {
          return `sync.ts must emit ${variant} audit records`;
        }
      }
      return null;
    },
  },
  {
    name: "@mention middleware emits structural audit records",
    filePath: "packages/a2a-client/src/middleware.ts",
    validate: (contents) => {
      for (const variant of [
        '"mention-dispatch-started"',
        '"mention-dispatch-succeeded"',
        '"mention-dispatch-failed"',
        '"mention-dispatch-unknown"',
        '"mention-dispatch-blocked"',
      ]) {
        if (!contents.includes(variant)) {
          return `middleware.ts must emit ${variant} audit records`;
        }
      }
      if (/promptText[^,}]*[,}]\s*[^)]*audit|audit[^)]*promptText/s.test(contents)) {
        return "middleware.ts audit records must not include promptText";
      }
      return null;
    },
  },
  {
    name: "a2a audit primitives are exported through browser-safe subpath",
    filePath: "packages/a2a/package.json",
    validate: (contents) => {
      if (!/"\.\/audit":\s*\{/.test(contents)) {
        return 'packages/a2a/package.json must export the "./audit" subpath';
      }
      if (!/"bun":\s*"\/?\.\/src\/audit\.ts"/.test(contents)) {
        return 'the "./audit" export must point Bun at ./src/audit.ts';
      }
      if (!/src\/index\.ts src\/audit\.ts/.test(contents)) {
        return "packages/a2a build script must emit dist/audit.* for package consumers";
      }
      return null;
    },
  },
  {
    name: "a2a-client imports audit without top-level a2a barrel",
    filePath: "packages/a2a-client/src/sync.ts",
    validate: (contents) => {
      if (/from\s+"@agents-js\/a2a"/.test(contents)) {
        return "sync.ts must not import the top-level @agents-js/a2a barrel into the browser-facing a2a-client bundle";
      }
      if (!/from\s+"@agents-js\/a2a\/audit"/.test(contents)) {
        return "sync.ts must import audit primitives from @agents-js/a2a/audit";
      }
      return null;
    },
  },
  {
    name: "a2a-client mention middleware imports audit without top-level a2a barrel",
    filePath: "packages/a2a-client/src/middleware.ts",
    validate: (contents) => {
      if (/from\s+"@agents-js\/a2a"/.test(contents)) {
        return "middleware.ts must not import the top-level @agents-js/a2a barrel into the browser-facing a2a-client bundle";
      }
      if (!/from\s+"@agents-js\/a2a\/audit"/.test(contents)) {
        return "middleware.ts must import audit primitives from @agents-js/a2a/audit";
      }
      return null;
    },
  },
  {
    name: "peer-sync wire is schema-driven (no hand-rolled allowlist)",
    filePath: "packages/a2a-client/src/sync.ts",
    validate: (contents) => {
      // The wire schema in @agents-js/validation owns *both* sides of
      // the wire contract: inbound parseWireRecord and outbound
      // buildSyncPayload. A regression that re-introduces the
      // hand-rolled `SYNC_WIRE_ALLOWED_FIELDS` array would mean we
      // are encoding the same truth twice — drift between the two
      // encodings is exactly what previously let ACP launch fields
      // leak through `kind="a2a"` records.
      if (!/WireAgentRegistryRecordSchema/.test(contents)) {
        return "sync.ts must consume WireAgentRegistryRecordSchema from @agents-js/validation";
      }
      if (!/validateWireAgentRegistryRecord/.test(contents)) {
        return "sync.ts must use validateWireAgentRegistryRecord for inbound parsing";
      }
      if (/SYNC_WIRE_ALLOWED_FIELDS/.test(contents)) {
        return "sync.ts contains SYNC_WIRE_ALLOWED_FIELDS — the schema-driven projection has regressed to a hand-rolled allowlist";
      }
      if (/projectAllowedFields/.test(contents)) {
        return "sync.ts contains projectAllowedFields — outbound projection must run through WireAgentRegistryRecordSchema";
      }
      return null;
    },
  },
  {
    name: "wire schema is A2A-only and rejects ACP launch fields",
    filePath: "packages/validation/src/registry.ts",
    validate: (contents) => {
      // Pin the load-bearing properties of the schema declaration
      // itself. A future edit that bumps `kind` to a union or moves
      // off `.strip()` (to `.passthrough()` for example) would
      // silently corrupt the security contract; preflight catches it
      // at the source.
      if (!/z\.literal\("a2a"\)/.test(contents)) {
        return 'registry.ts wire schema must lock kind to z.literal("a2a")';
      }
      if (!/\.strip\(\)/.test(contents)) {
        return "registry.ts wire schema must use .strip() so unknown fields are dropped";
      }
      for (const forbidden of ["command", "args", "env", "workspaceFlag"]) {
        // The forbidden field names must NOT appear as `<name>:` keys
        // in the schema declaration. We allow them in prose comments
        // (e.g., the file header explains why they are excluded).
        const re = new RegExp(`^\\s+${forbidden}:`, "m");
        if (re.test(contents)) {
          return `registry.ts wire schema declares "${forbidden}" — ACP launch fields must never appear on the wire`;
        }
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
    filePath: "packages/a2a/src/audit.ts",
    validate: (contents) => {
      if (!/_NoSensitivePayload/.test(contents)) {
        return "audit.ts must include the _NoSensitivePayload type-system guard";
      }
      // The set must reference every forbidden key. Order does not
      // matter; we just check each appears within the type alias.
      for (const key of ["prompt", "env", "args", "command", "payload"]) {
        if (!new RegExp(`"${key}"`).test(contents)) {
          return `audit.ts _NoSensitivePayload must list "${key}" as a forbidden key`;
        }
      }
      return null;
    },
  },
  {
    name: "dashboard status vocabulary has no deferred state",
    filePath: "scripts/build-dashboard.ts",
    validate: (contents) => {
      if (/\bdeferred\b/.test(contents)) {
        return "build-dashboard.ts must not expose a deferred dashboard status";
      }
      return null;
    },
  },
  {
    name: "dashboard status data has no deferred package statuses",
    filePath: "scripts/dashboard-status.json",
    validate: (contents) => {
      if (/\bdeferred\b/.test(contents)) {
        return "dashboard-status.json must use pending or blocked instead of deferred";
      }
      return null;
    },
  },
  {
    name: "README drift check is wired into bun run check",
    filePath: "package.json",
    validate: (contents) => {
      if (
        !/"docs:readmes:check":\s*"bun scripts\/generate-package-readmes\.ts --check"/.test(
          contents,
        )
      ) {
        return "package.json must define docs:readmes:check";
      }
      if (!/"check":\s*"[^"]*bun run docs:readmes:check/.test(contents)) {
        return "package.json check script must run docs:readmes:check";
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
  issues.push(...(await collectReleaseGapLanguageIssues(rootDir)));
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
