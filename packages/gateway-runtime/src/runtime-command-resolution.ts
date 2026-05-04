import path from "node:path";
import {
  DEFAULT_EXTRA_BIN_PATHS,
  type GatewayRuntimeDefinition,
  HOME_PLACEHOLDER,
  type RuntimeCommandResolver,
  type RuntimeResolutionOptions,
} from "./runtimes-registry.ts";

/**
 * Merge {@link DEFAULT_EXTRA_BIN_PATHS} (plus any caller-supplied extras)
 * onto a base `PATH` string, de-duplicating while preserving order. Existing
 * entries keep their position; new entries append in list order.
 */
export function buildExtendedPath(
  basePath: string | undefined,
  extraBinPaths?: readonly string[],
): string {
  // biome-ignore lint/style/noProcessEnv: HOME expansion intentionally reads the live process environment at runtime.
  const home = process.env.HOME ?? "";
  const resolvedDefaults = DEFAULT_EXTRA_BIN_PATHS.map((p) => p.replace(HOME_PLACEHOLDER, home));
  const extraDirs = [...resolvedDefaults, ...(extraBinPaths ?? [])].filter(Boolean);
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const dir of (basePath ?? "").split(":")) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    ordered.push(dir);
  }
  for (const dir of extraDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    ordered.push(dir);
  }
  return ordered.join(":");
}

export const defaultRuntimeCommandResolver: RuntimeCommandResolver = {
  which(command) {
    // biome-ignore lint/style/noProcessEnv: resolver probes the live parent env at registry resolution time.
    const extendedPath = buildExtendedPath(process.env.PATH);
    return Bun.which(command, { PATH: extendedPath }) ?? undefined;
  },
  async fileExists(filePath) {
    return Bun.file(filePath).exists();
  },
};

function collectWorkspaceBinRoots(startDir: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(startDir);

  while (true) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return roots;
    }
    current = parent;
  }
}

function isStandaloneCompiledBinary(modulePath: string): boolean {
  return path.extname(modulePath) === "";
}

function addWorkspaceBinRoots(roots: string[], seen: Set<string>, startDir: string): void {
  for (const root of collectWorkspaceBinRoots(startDir)) {
    const normalized = path.resolve(root);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    roots.push(normalized);
  }
}

function getWorkspaceBinRoots(options: RuntimeResolutionOptions): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  for (const binSearchRoot of options.binSearchRoots ?? []) {
    addWorkspaceBinRoots(roots, seen, binSearchRoot);
  }

  if (options.workspaceBinRoot) {
    addWorkspaceBinRoots(roots, seen, options.workspaceBinRoot);
    return roots;
  }

  const modulePath = options.modulePath;

  if (!modulePath || isStandaloneCompiledBinary(modulePath)) {
    return roots;
  }

  addWorkspaceBinRoots(roots, seen, path.dirname(modulePath));
  return roots;
}

function makeRuntimeNotFoundError(definition: GatewayRuntimeDefinition): Error {
  const dependencyDetails =
    definition.install.packageName && definition.install.version
      ? ` Expected package dependency: ${definition.install.packageName}@${definition.install.version}.`
      : "";

  return new Error(
    `[Gateway] Runtime "${definition.id}" could not resolve executable "${definition.command}". ${definition.install.installHint}${dependencyDetails}`,
  );
}

function getPackageBinaryPath(
  definition: GatewayRuntimeDefinition,
  workspaceBinRoot: string,
): string | undefined {
  if (!definition.install.packageName || !definition.install.packageBinPath) {
    return undefined;
  }

  return path.join(
    workspaceBinRoot,
    "node_modules",
    definition.install.packageName,
    definition.install.packageBinPath,
  );
}

async function resolvePackageCommandPath(
  definition: GatewayRuntimeDefinition,
  options: RuntimeResolutionOptions,
  resolver: RuntimeCommandResolver,
): Promise<string | undefined> {
  if (!definition.resolvesFromWorkspaceBin) {
    return undefined;
  }

  for (const workspaceBinRoot of getWorkspaceBinRoots(options)) {
    const workspaceBinary = path.join(workspaceBinRoot, "node_modules", ".bin", definition.command);
    if (await resolver.fileExists(workspaceBinary)) {
      return workspaceBinary;
    }

    const packageBinary = getPackageBinaryPath(definition, workspaceBinRoot);
    if (packageBinary && (await resolver.fileExists(packageBinary))) {
      return packageBinary;
    }
  }

  return undefined;
}

export async function resolveExistingCommandPath(
  command: string,
  resolver: RuntimeCommandResolver,
): Promise<string | undefined> {
  const resolvedFromPath = resolver.which(command);
  if (resolvedFromPath) {
    return resolvedFromPath;
  }

  if ((command.includes("/") || command.startsWith(".")) && (await resolver.fileExists(command))) {
    return command;
  }

  return undefined;
}

export async function resolveGatewayRuntimeCommand(
  definition: GatewayRuntimeDefinition,
  options: RuntimeResolutionOptions = {},
): Promise<string> {
  const resolver = options.resolver ?? defaultRuntimeCommandResolver;
  const resolvedFromPackage = await resolvePackageCommandPath(definition, options, resolver);
  if (resolvedFromPackage) {
    return resolvedFromPackage;
  }

  const resolvedFromPath = await resolveExistingCommandPath(definition.command, resolver);
  if (resolvedFromPath) {
    return resolvedFromPath;
  }

  throw makeRuntimeNotFoundError(definition);
}
