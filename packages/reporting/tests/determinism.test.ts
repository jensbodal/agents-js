import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateReportWithDeps } from "../src/orchestrator.ts";
import { createMockDeps } from "./helpers.ts";

describe("deterministic output", () => {
  test("same snapshot inputs produce byte-identical artifacts", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agents-js-reporting-"));
    const repoRoot = join(tempRoot, "repo");
    await mkdir(repoRoot, { recursive: true });

    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({ name: "@agents-js/root", private: true }, null, 2),
    );

    const deps = createMockDeps();

    const first = await generateReportWithDeps(
      {
        repoRoot,
        outDir: join(tempRoot, "reports-one"),
      },
      deps,
    );

    const second = await generateReportWithDeps(
      {
        repoRoot,
        outDir: join(tempRoot, "reports-two"),
      },
      deps,
    );

    const firstFiles = await Promise.all([
      readFile(first.findingsPath, "utf8"),
      readFile(first.canvasPath, "utf8"),
      readFile(first.evidencePath, "utf8"),
      readFile(first.sourcesPath, "utf8"),
    ]);

    const secondFiles = await Promise.all([
      readFile(second.findingsPath, "utf8"),
      readFile(second.canvasPath, "utf8"),
      readFile(second.evidencePath, "utf8"),
      readFile(second.sourcesPath, "utf8"),
    ]);

    expect(firstFiles).toEqual(secondFiles);

    await rm(tempRoot, { recursive: true, force: true });
  });
});
