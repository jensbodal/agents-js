import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PI_EXTENSION_PACKAGE = "@agents-js/pi-extension";
const SOURCE_PI_EXTENSION_PACKAGE_JSON = path.join("extras", "pi-extension", "package.json");

type PackageManifest = {
  pi?: {
    extensions?: string[];
  };
};

export interface ResolveDefaultPiExtensionSpecOptions {
  /**
   * Module URL used as the starting point for source-worktree discovery.
   * Production callers normally omit this; tests inject it for deterministic
   * fixtures.
   */
  readonly moduleUrl?: string;
  /** Resolve a package specifier to a URL/path. Defaults to import.meta.resolve. */
  readonly resolveSpecifier?: (specifier: string) => string;
  /** Filesystem existence seam for tests. */
  readonly fileExists?: (filePath: string) => boolean;
  /** File read seam for tests. */
  readonly readTextFile?: (filePath: string) => string;
}

function defaultResolveSpecifier(specifier: string): string {
  return import.meta.resolve(specifier);
}

function toPath(resolved: string): string {
  return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
}

function readManifest(
  manifestPath: string,
  readTextFile: (filePath: string) => string,
): PackageManifest | null {
  try {
    return JSON.parse(readTextFile(manifestPath)) as PackageManifest;
  } catch {
    return null;
  }
}

function extensionFromManifest(
  manifestPath: string,
  fileExists: (filePath: string) => boolean,
  readTextFile: (filePath: string) => string,
): string | undefined {
  const manifest = readManifest(manifestPath, readTextFile);
  const extension = manifest?.pi?.extensions?.[0];
  if (!extension) return undefined;

  const extensionPath = path.resolve(path.dirname(manifestPath), extension);
  return fileExists(extensionPath) ? extensionPath : undefined;
}

function resolveInstalledPackageExtension(
  resolveSpecifier: (specifier: string) => string,
  fileExists: (filePath: string) => boolean,
  readTextFile: (filePath: string) => string,
): string | undefined {
  try {
    const manifestPath = toPath(resolveSpecifier(`${PI_EXTENSION_PACKAGE}/package.json`));
    return extensionFromManifest(manifestPath, fileExists, readTextFile);
  } catch {
    return undefined;
  }
}

function collectAncestorDirs(startDir: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  while (true) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

function resolveSourceWorktreeExtension(
  moduleUrl: string,
  fileExists: (filePath: string) => boolean,
  readTextFile: (filePath: string) => string,
): string | undefined {
  const moduleDir = path.dirname(toPath(moduleUrl));
  for (const dir of collectAncestorDirs(moduleDir)) {
    const manifestPath = path.join(dir, SOURCE_PI_EXTENSION_PACKAGE_JSON);
    if (!fileExists(manifestPath)) continue;
    return extensionFromManifest(manifestPath, fileExists, readTextFile);
  }
  return undefined;
}

/**
 * Resolve the default native-Pi extension spec for source/worktree launches.
 *
 * The Pi extension runtime cannot locate itself: Pi must resolve `-e <spec>`
 * before the extension module is loaded. This helper therefore lives with the
 * launcher and reads the extension package's own `pi.extensions` metadata. If
 * no installed package or source-worktree bundle is available, callers should
 * fall back to the public package spec (`@agents-js/pi-extension`).
 */
export function resolveDefaultPiExtensionSpec(
  options: ResolveDefaultPiExtensionSpecOptions = {},
): string | undefined {
  const fileExists = options.fileExists ?? existsSync;
  const readTextFile =
    options.readTextFile ?? ((filePath: string) => readFileSync(filePath, "utf8"));
  const resolveSpecifier = options.resolveSpecifier ?? defaultResolveSpecifier;
  return (
    resolveInstalledPackageExtension(resolveSpecifier, fileExists, readTextFile) ??
    resolveSourceWorktreeExtension(options.moduleUrl ?? import.meta.url, fileExists, readTextFile)
  );
}
