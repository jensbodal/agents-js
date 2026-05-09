import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const forbiddenImportPatterns = [
  /from\s+["'][^"']*packages\/[^/]+\/src\//,
  /import\s*\(\s*["'][^"']*packages\/[^/]+\/src\//,
] as const;

async function collectSourceFiles(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }

    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/.test(entry.name)) {
      continue;
    }

    if (/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)) {
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

async function findBoundaryViolations(rootRelativeDir: string): Promise<string[]> {
  const absoluteRoot = path.join(repoRoot, rootRelativeDir);
  const files = await collectSourceFiles(absoluteRoot);
  const violations: string[] = [];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    const hasViolation = forbiddenImportPatterns.some((pattern) => pattern.test(content));
    if (hasViolation) {
      violations.push(path.relative(repoRoot, filePath));
    }
  }

  return violations.sort();
}

describe("package boundaries", () => {
  test("apps do not import package src paths directly", async () => {
    expect(await findBoundaryViolations("apps")).toEqual([]);
  });

  test("non-test scripts do not import package src paths directly", async () => {
    expect(await findBoundaryViolations("scripts")).toEqual([]);
  });
});
