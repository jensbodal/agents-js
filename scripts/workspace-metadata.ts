import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type DependencyBlockName = "dependencies" | "devDependencies" | "peerDependencies";
export type TaskInputBase = "workspace" | "package";

export interface WorkspaceBuildOutput {
  label: string;
  relativePath: string;
}

export interface TaskInputAutoEntry {
  auto: true;
}

export interface TaskInputGlobEntry {
  base: TaskInputBase;
  pattern: string;
}

export type TaskInputEntry = TaskInputAutoEntry | TaskInputGlobEntry;

export interface WorkspaceTask {
  cache?: boolean;
  command: string;
  cwd?: string;
  dependsOn?: string[];
  input?: readonly TaskInputEntry[];
}

export interface PackageManifest {
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: unknown;
  main?: string;
  module?: string;
  name: string;
  peerDependencies?: Record<string, string>;
  pi?: {
    extensions?: string[];
  };
  private?: boolean;
  scripts?: Record<string, string>;
  types?: string;
  workspaces?: string[] | { packages?: string[] };
}

export interface WorkspacePackage {
  buildTaskName: string | null;
  dirName: string;
  hasTests: boolean;
  manifest: PackageManifest;
  manifestPath: string;
  relativePath: string;
  testTaskName: string | null;
}

export interface BuildGraphValidationResult {
  buildTaskCount: number;
  issueCount: number;
  issues: string[];
  outputCount: number;
  testTaskCount: number;
  workspaceCount: number;
}

const dependencyBlockNames: readonly DependencyBlockName[] = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
];

const supplementalBuildOutputs: readonly WorkspaceBuildOutput[] = [
  { label: "@agents-js/web-ui", relativePath: "apps/web-ui/dist/index.html" },
];

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export function createBuildInput(relativePath: string): readonly TaskInputEntry[] {
  return [
    { auto: true },
    { pattern: "!node_modules/.vite-temp/**", base: "workspace" },
    { pattern: "!node_modules/.vite-temp/**", base: "package" },
    { pattern: `!${toPosixPath(relativePath)}/node_modules/.vite-temp/**`, base: "workspace" },
    { pattern: "!node_modules/.vite/task-cache/**", base: "workspace" },
    { pattern: "!node_modules/.vite/task-cache/**", base: "package" },
    {
      pattern: `!${toPosixPath(relativePath)}/node_modules/.vite/task-cache/**`,
      base: "workspace",
    },
    { pattern: "!src/generated/*.tmp.ts", base: "package" },
    { pattern: `!${toPosixPath(relativePath)}/src/generated/*.tmp.ts`, base: "workspace" },
    { pattern: "!dist/**", base: "package" },
    { pattern: `!${toPosixPath(relativePath)}/dist/**`, base: "workspace" },
  ] as const;
}

export function loadWorkspacePackages(rootDir = repoRoot): WorkspacePackage[] {
  const rootManifest = readManifest(path.join(rootDir, "package.json"));
  const workspacePaths = workspacePackagePaths(rootDir, workspacePatterns(rootManifest));

  return workspacePaths
    .map((relativePath): WorkspacePackage => {
      const manifestPath = path.join(rootDir, relativePath, "package.json");
      const manifest = readManifest(manifestPath);
      const hasTests = hasWorkspaceTests(rootDir, relativePath);
      const taskBaseName = workspaceTaskBaseName(relativePath, manifest);

      return {
        buildTaskName: manifest.scripts?.build ? `${taskBaseName}:build` : null,
        dirName: path.posix.basename(relativePath),
        hasTests,
        manifest,
        manifestPath,
        relativePath,
        testTaskName: manifest.scripts?.test || hasTests ? `${taskBaseName}:test` : null,
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function createWorkspaceBuildTasks(
  packages = loadWorkspacePackages(),
): Record<string, WorkspaceTask> {
  const packageByName = packageNameMap(packages);
  const tasks: Record<string, WorkspaceTask> = {};

  for (const workspacePackage of packages) {
    if (!workspacePackage.buildTaskName) {
      continue;
    }

    const dependsOn = firstPartyBuildDependencies(workspacePackage, packageByName);
    tasks[workspacePackage.buildTaskName] = {
      command: "bun run build",
      cwd: workspacePackage.relativePath,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      input: createBuildInput(workspacePackage.relativePath),
    };
  }

  return tasks;
}

export function createWorkspaceTestTasks(
  packages = loadWorkspacePackages(),
): Record<string, WorkspaceTask> {
  const packageByName = packageNameMap(packages);
  const tasks: Record<string, WorkspaceTask> = {};

  for (const workspacePackage of packages) {
    if (!workspacePackage.testTaskName) {
      continue;
    }

    const dependsOn = workspacePackage.buildTaskName
      ? [workspacePackage.buildTaskName]
      : firstPartyBuildDependencies(workspacePackage, packageByName);
    const command = workspacePackage.manifest.scripts?.test ? "bun run test" : "bun test tests";

    tasks[workspacePackage.testTaskName] = {
      command,
      cwd: workspacePackage.relativePath,
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      input: createBuildInput(workspacePackage.relativePath),
    };
  }

  return tasks;
}

export function createWorkspaceBuildTaskNames(packages = loadWorkspacePackages()): string[] {
  return packages.flatMap((workspacePackage) =>
    workspacePackage.buildTaskName ? [workspacePackage.buildTaskName] : [],
  );
}

export function createWorkspaceTestTaskNames(packages = loadWorkspacePackages()): string[] {
  return packages.flatMap((workspacePackage) =>
    workspacePackage.testTaskName ? [workspacePackage.testTaskName] : [],
  );
}

export function collectWorkspaceBuildOutputs(
  packages = loadWorkspacePackages(),
): WorkspaceBuildOutput[] {
  const outputsByPath = new Map<string, WorkspaceBuildOutput>();

  for (const workspacePackage of packages) {
    if (!workspacePackage.buildTaskName) {
      continue;
    }

    for (const outputPath of manifestDistOutputs(workspacePackage.manifest)) {
      const relativePath = toPosixPath(path.posix.join(workspacePackage.relativePath, outputPath));
      outputsByPath.set(relativePath, {
        label: `${workspacePackage.manifest.name}:${outputPath}`,
        relativePath,
      });
    }
  }

  for (const output of supplementalBuildOutputs) {
    outputsByPath.set(output.relativePath, output);
  }

  return [...outputsByPath.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

export const workspaceBuildOutputs = collectWorkspaceBuildOutputs();

export function validateWorkspaceBuildGraph(
  packages = loadWorkspacePackages(),
): BuildGraphValidationResult {
  const issues: string[] = [];
  const packageByName = packageNameMap(packages);
  const buildTasks = createWorkspaceBuildTasks(packages);
  const testTasks = createWorkspaceTestTasks(packages);
  const trackedOutputs = new Set(
    collectWorkspaceBuildOutputs(packages).map((entry) => entry.relativePath),
  );

  for (const workspacePackage of packages) {
    if (workspacePackage.manifest.scripts?.build && !workspacePackage.buildTaskName) {
      issues.push(`${workspacePackage.relativePath}: missing generated build task`);
    }

    if (
      (workspacePackage.manifest.scripts?.test || workspacePackage.hasTests) &&
      !workspacePackage.testTaskName
    ) {
      issues.push(`${workspacePackage.relativePath}: missing generated test task`);
    }

    if (workspacePackage.buildTaskName) {
      const task = buildTasks[workspacePackage.buildTaskName];
      if (!task) {
        issues.push(
          `${workspacePackage.relativePath}: build task ${workspacePackage.buildTaskName} was not generated`,
        );
      } else {
        const expectedDependsOn = firstPartyBuildDependencies(workspacePackage, packageByName);
        const actualDependsOn = task.dependsOn ?? [];
        for (const dependencyTaskName of expectedDependsOn) {
          if (!actualDependsOn.includes(dependencyTaskName)) {
            issues.push(
              `${workspacePackage.relativePath}: build task ${workspacePackage.buildTaskName} is missing dependsOn ${dependencyTaskName}`,
            );
          }
        }

        issues.push(...validateBuildInput(workspacePackage.relativePath, task.input ?? []));
      }

      for (const outputPath of manifestDistOutputs(workspacePackage.manifest)) {
        const relativeOutputPath = toPosixPath(
          path.posix.join(workspacePackage.relativePath, outputPath),
        );
        if (!trackedOutputs.has(relativeOutputPath)) {
          issues.push(
            `${workspacePackage.relativePath}: manifest output ${relativeOutputPath} is not tracked`,
          );
        }
      }
    }

    if (workspacePackage.testTaskName && !testTasks[workspacePackage.testTaskName]) {
      issues.push(
        `${workspacePackage.relativePath}: test task ${workspacePackage.testTaskName} was not generated`,
      );
    }
  }

  issues.push(...collectBuildCycleIssues(buildTasks));

  return {
    buildTaskCount: Object.keys(buildTasks).length,
    issueCount: issues.length,
    issues: issues.sort(),
    outputCount: trackedOutputs.size,
    testTaskCount: Object.keys(testTasks).length,
    workspaceCount: packages.length,
  };
}

function readManifest(manifestPath: string): PackageManifest {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  if (!isRecord(raw) || typeof raw.name !== "string") {
    throw new Error(`${manifestPath}: expected package manifest with a string name`);
  }
  return raw as unknown as PackageManifest;
}

function workspacePatterns(rootManifest: PackageManifest): string[] {
  if (Array.isArray(rootManifest.workspaces)) {
    return rootManifest.workspaces;
  }

  if (Array.isArray(rootManifest.workspaces?.packages)) {
    return rootManifest.workspaces.packages;
  }

  throw new Error("Root package.json must define workspaces as an array or { packages }.");
}

function workspacePackagePaths(rootDir: string, patterns: readonly string[]): string[] {
  const relativePaths = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      const parentDir = path.join(rootDir, parent);
      if (!existsSync(parentDir)) {
        continue;
      }

      for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const relativePath = toPosixPath(path.posix.join(parent, entry.name));
        if (existsSync(path.join(rootDir, relativePath, "package.json"))) {
          relativePaths.add(relativePath);
        }
      }
      continue;
    }

    const relativePath = toPosixPath(pattern);
    if (existsSync(path.join(rootDir, relativePath, "package.json"))) {
      relativePaths.add(relativePath);
    }
  }

  return [...relativePaths].sort();
}

function workspaceTaskBaseName(relativePath: string, manifest: PackageManifest): string {
  if (relativePath.startsWith("apps/")) {
    return `app:${path.posix.basename(relativePath)}`;
  }

  return `pkg:${manifest.name.replace(/^@agents-js\//, "")}`;
}

function hasWorkspaceTests(rootDir: string, relativePath: string): boolean {
  const testsDir = path.join(rootDir, relativePath, "tests");
  if (!existsSync(testsDir)) {
    return false;
  }

  return hasTestFile(testsDir);
}

function hasTestFile(dirPath: string): boolean {
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (hasTestFile(entryPath)) {
        return true;
      }
      continue;
    }

    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      return true;
    }
  }

  return false;
}

function packageNameMap(packages: readonly WorkspacePackage[]): Map<string, WorkspacePackage> {
  return new Map(
    packages.map((workspacePackage) => [workspacePackage.manifest.name, workspacePackage]),
  );
}

function firstPartyBuildDependencies(
  workspacePackage: WorkspacePackage,
  packageByName: ReadonlyMap<string, WorkspacePackage>,
): string[] {
  const dependencyTaskNames = new Set<string>();

  for (const blockName of dependencyBlockNames) {
    for (const dependencyName of Object.keys(workspacePackage.manifest[blockName] ?? {})) {
      const dependencyPackage = packageByName.get(dependencyName);
      if (!dependencyPackage?.buildTaskName) {
        continue;
      }
      if (dependencyPackage.buildTaskName !== workspacePackage.buildTaskName) {
        dependencyTaskNames.add(dependencyPackage.buildTaskName);
      }
    }
  }

  return [...dependencyTaskNames].sort();
}

function manifestDistOutputs(manifest: PackageManifest): string[] {
  const outputs = new Set<string>();

  for (const value of [manifest.main, manifest.module, manifest.types]) {
    addDistOutput(outputs, value);
  }

  for (const value of exportPathValues(manifest.exports)) {
    addDistOutput(outputs, value);
  }

  if (typeof manifest.bin === "string") {
    addDistOutput(outputs, manifest.bin);
  } else if (isRecord(manifest.bin)) {
    for (const value of Object.values(manifest.bin)) {
      if (typeof value === "string") {
        addDistOutput(outputs, value);
      }
    }
  }

  for (const extensionPath of manifest.pi?.extensions ?? []) {
    addDistOutput(outputs, extensionPath);
  }

  return [...outputs].sort();
}

function exportPathValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => exportPathValues(entry));
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap((entry) => exportPathValues(entry));
  }

  return [];
}

function addDistOutput(outputs: Set<string>, value: string | undefined): void {
  if (!value) {
    return;
  }

  const normalized = toPosixPath(value.replace(/^\.\//, ""));
  if (normalized.startsWith("dist/") && !normalized.includes("*")) {
    outputs.add(normalized);
  }
}

function validateBuildInput(relativePath: string, input: readonly TaskInputEntry[]): string[] {
  const issues: string[] = [];
  const expectedEntries: readonly TaskInputGlobEntry[] = [
    { pattern: "!node_modules/.vite-temp/**", base: "workspace" },
    { pattern: "!node_modules/.vite-temp/**", base: "package" },
    { pattern: `!${toPosixPath(relativePath)}/node_modules/.vite-temp/**`, base: "workspace" },
    { pattern: "!node_modules/.vite/task-cache/**", base: "workspace" },
    { pattern: "!node_modules/.vite/task-cache/**", base: "package" },
    {
      pattern: `!${toPosixPath(relativePath)}/node_modules/.vite/task-cache/**`,
      base: "workspace",
    },
    { pattern: "!src/generated/*.tmp.ts", base: "package" },
    { pattern: `!${toPosixPath(relativePath)}/src/generated/*.tmp.ts`, base: "workspace" },
    { pattern: "!dist/**", base: "package" },
    { pattern: `!${toPosixPath(relativePath)}/dist/**`, base: "workspace" },
  ];

  const hasAutoInput = input.some((entry) => "auto" in entry && entry.auto === true);
  if (!hasAutoInput) {
    issues.push(`${relativePath}: build input is missing automatic tracking`);
  }

  for (const expectedEntry of expectedEntries) {
    const found = input.some(
      (entry) =>
        "pattern" in entry &&
        entry.pattern === expectedEntry.pattern &&
        entry.base === expectedEntry.base,
    );
    if (!found) {
      issues.push(
        `${relativePath}: build input is missing ${expectedEntry.base} exclusion ${expectedEntry.pattern}`,
      );
    }
  }

  return issues;
}

function collectBuildCycleIssues(tasks: Record<string, WorkspaceTask>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const issues = new Set<string>();

  function visit(taskName: string, trail: string[]): void {
    if (visited.has(taskName)) {
      return;
    }
    if (visiting.has(taskName)) {
      issues.add(`build task dependency cycle detected: ${[...trail, taskName].join(" -> ")}`);
      return;
    }

    visiting.add(taskName);
    for (const dependencyTaskName of tasks[taskName]?.dependsOn ?? []) {
      if (tasks[dependencyTaskName]) {
        visit(dependencyTaskName, [...trail, taskName]);
      }
    }
    visiting.delete(taskName);
    visited.add(taskName);
  }

  for (const taskName of Object.keys(tasks)) {
    visit(taskName, []);
  }

  return [...issues].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
