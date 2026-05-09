import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const ignoredDirNames = new Set([".git", ".vitepress", "dist", "node_modules", "out", "output"]);
const ignoredRelativeDirs = new Set(["docs/api", "docs/public"]);

interface Issue {
  column?: number;
  file: string;
  line: number;
  message: string;
}

interface FenceState {
  char: "`" | "~";
  length: number;
  line: number;
}

function toRelative(filePath: string): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function shouldSkipDirectory(dirPath: string): boolean {
  const name = path.basename(dirPath);
  if (ignoredDirNames.has(name)) {
    return true;
  }
  return ignoredRelativeDirs.has(toRelative(dirPath));
}

function walkMarkdown(targetPath: string, out: string[]): void {
  const stat = lstatSync(targetPath);
  if (stat.isDirectory()) {
    if (shouldSkipDirectory(targetPath)) {
      return;
    }
    for (const entry of readdirSync(targetPath)) {
      walkMarkdown(path.join(targetPath, entry), out);
    }
    return;
  }
  if (stat.isFile() && targetPath.endsWith(".md")) {
    out.push(targetPath);
  }
}

function parseTargets(rawTargets: string[]): string[] {
  const targets =
    rawTargets.length > 0
      ? rawTargets
      : ["README.md", "CONTRIBUTING.md", "docs", "packages", "apps", "extras", "tests"];

  const files: string[] = [];
  for (const rawTarget of targets) {
    const targetPath = path.resolve(repoRoot, rawTarget);
    walkMarkdown(targetPath, files);
  }

  return [...new Set(files)].sort((a, b) => toRelative(a).localeCompare(toRelative(b)));
}

function checkFile(filePath: string): Issue[] {
  const issues: Issue[] = [];
  const content = readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  let openFence: FenceState | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const relative = toRelative(filePath);
    const trailingWhitespace = line.match(/[ \t]+$/);

    if (trailingWhitespace) {
      issues.push({
        file: relative,
        line: lineNumber,
        column: trailingWhitespace.index + 1,
        message: "Trailing whitespace.",
      });
    }

    if (/^(<<<<<<<|=======|>>>>>>>)($| )/.test(line)) {
      issues.push({
        file: relative,
        line: lineNumber,
        message: "Unresolved merge-conflict marker.",
      });
    }

    const fence = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (!fence) {
      continue;
    }

    const marker = fence[2];
    const char = marker[0] as "`" | "~";
    if (!openFence) {
      openFence = { char, length: marker.length, line: lineNumber };
      continue;
    }

    if (openFence.char === char && marker.length >= openFence.length) {
      openFence = null;
    }
  }

  if (openFence) {
    issues.push({
      file: toRelative(filePath),
      line: openFence.line,
      message: "Unclosed fenced code block.",
    });
  }

  return issues;
}

function main(): void {
  let files: string[];
  try {
    files = parseTargets(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[docs:markdown:check] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (files.length === 0) {
    console.error("[docs:markdown:check] No Markdown files matched the provided paths.");
    process.exit(1);
  }

  const issues = files.flatMap(checkFile);
  if (issues.length > 0) {
    console.error(`[docs:markdown:check] Found ${issues.length} Markdown issue(s):`);
    for (const issue of issues) {
      const location =
        issue.column === undefined
          ? `${issue.file}:${issue.line}`
          : `${issue.file}:${issue.line}:${issue.column}`;
      console.error(`- ${location} ${issue.message}`);
    }
    process.exit(1);
  }

  console.log(`✓ docs:markdown:check: checked ${files.length} Markdown file(s)`);
}

main();
