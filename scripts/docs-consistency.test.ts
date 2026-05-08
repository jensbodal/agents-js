import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectFileExpectationIssues,
  collectFrontmatterTagIssues,
  collectGraphPackageIssues,
  collectTsMorphBoundaryIssues,
  collectUserFacingForbiddenIssues,
} from "./docs-consistency.ts";

describe("docs-consistency", () => {
  /**
   * WHAT: Pin that the generated dependency graph contains exactly the current
   * workspace package names discovered from package manifests.
   * WHY: The graph is consumed by docs and agents; stale package-count prose hid
   * missing packages until the generated payload was compared with manifests.
   */
  test("rejects generated dependency graphs that drift from workspace manifests", () => {
    const issues = collectGraphPackageIssues(
      ["@agents-js/acp", "@agents-js/browser-runtime", "@agents-js/a2ui-host"],
      ["@agents-js/acp", "@agents-js/old-package"],
    );

    expect(issues).toEqual([
      "docs/public/graph.json is missing workspace packages: @agents-js/a2ui-host, @agents-js/browser-runtime",
      "docs/public/graph.json contains non-workspace packages: @agents-js/old-package",
    ]);
  });

  /**
   * WHAT: Pin the user-facing positioning guard named in AGENTS.md.
   * WHY: README/docs/index positioning is canonical; consumer docs must not
   * regress into Bun-as-product framing or unpublished-package hedges.
   */
  test("collectUserFacingForbiddenIssues flags Bun-toolkit framing and publication hedges", () => {
    const issues = collectUserFacingForbiddenIssues([
      {
        path: "docs/index.md",
        content: "agents-js is a Bun toolkit. Until `@agents-js/cli` is published, use a clone.",
      },
      {
        path: "README.md",
        content: "A TypeScript library tying together protocol surfaces.",
      },
    ]);

    expect(issues).toEqual([
      "docs/index.md: contains consumer-facing 'Bun toolkit' framing: Bun toolkit",
      "docs/index.md: contains publication hedge: Until `@agents-js/cli` is published",
    ]);
  });

  /**
   * WHAT: Pin that optional operator files are checked when present but do not
   * make docs consistency fail on clean worktrees where they are absent.
   * WHY: Optional operator notes are outside tracked repo content; requiring
   * them would make `bun run check` depend on untracked files.
   */
  test("skips optional expectations when the file is absent", async () => {
    const issues = await collectFileExpectationIssues(
      [
        {
          path: ".factory/library/user-testing.md",
          optional: true,
          contains: ["bun run browser:smoke"],
        },
      ],
      async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    );

    expect(issues).toEqual([]);
  });

  /**
   * WHAT: Pin that file expectations start independent reads concurrently while
   * preserving expectation-order diagnostics.
   * WHY: Optional local files need per-file ENOENT handling, but docs checks
   * should not regress into serialized filesystem reads as the expectation list
   * grows.
   */
  test("reads file expectations concurrently with stable issue order", async () => {
    const started: string[] = [];
    const resolvers = new Map<string, (content: string) => void>();
    const read = (relativePath: string) =>
      new Promise<string>((resolve) => {
        started.push(relativePath);
        resolvers.set(relativePath, resolve);
      });

    const issuesPromise = collectFileExpectationIssues(
      [
        { path: "a.md", contains: ["present"] },
        { path: "b.md", contains: ["present"] },
      ],
      read,
    );

    expect(started).toEqual(["a.md", "b.md"]);
    resolvers.get("b.md")?.("missing");
    resolvers.get("a.md")?.("missing");

    expect(await issuesPromise).toEqual([
      "a.md: missing required text: present",
      "b.md: missing required text: present",
    ]);
  });

  /**
   * WHAT: Pin that every hand-authored page declares its Diátaxis category
   * via a `diataxis:` frontmatter tag drawn from a closed set.
   * WHY: The Diátaxis tag is real architectural metadata; the gate catches
   * typoed tags and missing frontmatter.
   */
  test("collectFrontmatterTagIssues — happy path with mixed Diátaxis tags", async () => {
    const issues = await collectFrontmatterTagIssues(
      {
        handAuthoredPages: [
          "_generated/README.md",
          "getting-started.md",
          "harness-guide.md",
          "protocols.md",
        ],
      },
      async (relative) => {
        switch (relative) {
          case "docs/_generated/README.md":
            return "---\ntitle: Index\ndiataxis: reference\n---\n";
          case "docs/getting-started.md":
            return "---\ntitle: Getting Started\ndiataxis: tutorial\n---\n";
          case "docs/harness-guide.md":
            return "---\ndiataxis: howto\n---\n\nProse only.\n";
          case "docs/protocols.md":
            return "---\ndiataxis: reference\n---\n\nProse only.\n";
          default:
            throw new Error(`unexpected read: ${relative}`);
        }
      },
    );

    expect(issues).toEqual([]);
  });

  test("collectFrontmatterTagIssues — flags missing tag and invalid tag", async () => {
    const issues = await collectFrontmatterTagIssues(
      {
        handAuthoredPages: ["no-frontmatter.md", "wrong-tag.md"],
      },
      async (relative) => {
        switch (relative) {
          case "docs/no-frontmatter.md":
            return "# Just markdown, no frontmatter\n";
          case "docs/wrong-tag.md":
            return "---\ndiataxis: deepDive\n---\n";
          default:
            throw new Error(`unexpected read: ${relative}`);
        }
      },
    );

    expect(issues).toEqual([
      "docs/no-frontmatter.md: missing frontmatter (must include a 'diataxis:' tag)",
      "docs/wrong-tag.md: 'diataxis: deepDive' is not a valid Diátaxis tag (allowed: explanation, howto, landing, reference, tutorial)",
    ]);
  });

  /**
   * WHAT: Pin that ENOENT during a manifest-listed read collapses to a clean
   * "file does not exist" diagnostic, but other read failures surface the
   * underlying error message.
   * WHY: A typoed manifest entry should produce a precise hint; an unrelated
   * I/O failure (permission denied, etc.) should not be silently relabeled
   * as a missing file.
   */
  test("collectFrontmatterTagIssues — distinguishes ENOENT from other read failures", async () => {
    const issues = await collectFrontmatterTagIssues(
      {
        handAuthoredPages: ["missing.md", "broken.md"],
      },
      async (relative) => {
        if (relative === "docs/missing.md") {
          throw Object.assign(new Error("not found"), { code: "ENOENT" });
        }
        throw new Error("permission denied");
      },
    );

    expect(issues).toEqual([
      "docs/missing.md: listed in manifest.handAuthoredPages but file does not exist",
      "docs/broken.md: listed in manifest.handAuthoredPages but unreadable: permission denied",
    ]);
  });

  /**
   * WHAT: Pin that the ts-morph wrapper boundary gate reports an error when an
   * unauthorized script imports `ts-morph`, and stays silent when only the
   * allowlisted wrapper does.
   * WHY: ts-morph is a heavy dependency; confining it to one file bounds the
   * blast radius of upgrades and version bumps. The gate is the mechanical
   * enforcer.
   */
  test("collectTsMorphBoundaryIssues — passes for allowlisted wrapper, fails for unauthorized importer", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsmorph-boundary-"));
    try {
      const scriptsDir = join(root, "scripts");
      const libDir = join(scriptsDir, "lib");
      // Use bun's mkdir via writeFileSync auto-creating? We need explicit:
      const { mkdirSync } = await import("node:fs");
      mkdirSync(libDir, { recursive: true });

      // Allowlisted wrapper imports ts-morph.
      writeFileSync(
        join(libDir, "package-introspection.ts"),
        `import { Project } from "ts-morph";\nexport const p = new Project();\n`,
      );
      // No violations expected.
      const passing = await collectTsMorphBoundaryIssues(root);
      expect(passing).toEqual([]);

      // Add an unauthorized importer.
      writeFileSync(
        join(scriptsDir, "rogue.ts"),
        `import { Project } from "ts-morph";\nconsole.log(Project);\n`,
      );
      const failing = await collectTsMorphBoundaryIssues(root);
      expect(failing).toEqual([
        "scripts/rogue.ts: imports 'ts-morph' but the wrapper boundary requires only scripts/lib/package-introspection.ts to import it. Consume introspection via that module's exported helpers.",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * WHAT: Pin that running `bun scripts/docs-reference.ts --write` twice in a
   * row produces byte-stable output (modulo the volatile timestamp +
   * generator-SHA lines, which the drift normalization explicitly excludes).
   * WHY: A flaky generator that produces different bytes on each invocation
   * defeats the entire point of the drift gate. This is the byte-stability
   * contract.
   */
  test("docs-reference --write is byte-stable across runs (modulo timestamp + SHA)", async () => {
    const partials = ["acp-validated-surface.md", "cli-command-table.md", "runtime-matrix.md"];
    const repoRoot = join(import.meta.dirname, "..");
    const generatedDir = join(repoRoot, "docs", "_generated");

    const snapshot = (): Map<string, string> => {
      const out = new Map<string, string>();
      for (const name of partials) {
        out.set(name, readFileSync(join(generatedDir, name), "utf-8"));
      }
      return out;
    };

    const normalize = (s: string): string =>
      s
        .replace(/^<!-- Generated at: [^\n]*-->\n?/m, "")
        .replace(/^<!-- Generator commit: [^\n]*-->\n?/m, "");

    // First run.
    const first = Bun.spawnSync({
      cmd: ["bun", "scripts/docs-reference.ts", "--write"],
      cwd: repoRoot,
    });
    expect(first.exitCode).toBe(0);
    const after1 = snapshot();

    // Second run.
    const second = Bun.spawnSync({
      cmd: ["bun", "scripts/docs-reference.ts", "--write"],
      cwd: repoRoot,
    });
    expect(second.exitCode).toBe(0);
    const after2 = snapshot();

    for (const name of partials) {
      expect(normalize(after2.get(name) ?? "")).toBe(normalize(after1.get(name) ?? ""));
    }
  });
});
