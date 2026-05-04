import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @internal */
export interface CliRuntimeBinSearchRootsInput {
  execPath?: string;
  moduleUrl?: string;
}

function addRoot(roots: string[], seen: Set<string>, root: string): void {
  const normalized = path.resolve(root);
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  roots.push(normalized);
}

function safeRealpath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

function addExecPathRoot(roots: string[], seen: Set<string>, execPath: string): void {
  for (const candidate of [execPath, safeRealpath(execPath)]) {
    if (path.basename(candidate) !== "agents-js") {
      continue;
    }

    const binaryDir = path.dirname(candidate);
    const packageRoot = path.basename(binaryDir) === "dist" ? path.dirname(binaryDir) : binaryDir;
    addRoot(roots, seen, packageRoot);
  }
}

function addModuleUrlRoot(roots: string[], seen: Set<string>, moduleUrl: string): void {
  let url: URL;
  try {
    url = new URL(moduleUrl);
  } catch {
    return;
  }

  if (url.protocol !== "file:") {
    return;
  }

  const modulePath = fileURLToPath(url);
  const moduleDir = path.dirname(modulePath);
  const packageRoot =
    path.basename(moduleDir) === "src" || path.basename(moduleDir) === "dist"
      ? path.dirname(moduleDir)
      : moduleDir;
  addRoot(roots, seen, packageRoot);
}

/** @internal */
export function getCliRuntimeBinSearchRoots(input: CliRuntimeBinSearchRootsInput = {}): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  addExecPathRoot(roots, seen, input.execPath ?? process.execPath);
  addModuleUrlRoot(roots, seen, input.moduleUrl ?? import.meta.url);

  return roots;
}

/** @internal */
export function getCliRuntimeResolutionOptions(): { binSearchRoots: string[] } {
  return {
    binSearchRoots: getCliRuntimeBinSearchRoots(),
  };
}
