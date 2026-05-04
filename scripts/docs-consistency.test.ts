import { describe, expect, test } from "bun:test";
import {
  collectFileExpectationIssues,
  collectGraphPackageIssues,
  collectProviderHostReferenceIssues,
  collectRemovedDocPathIssues,
} from "./docs-consistency.ts";

describe("docs-consistency", () => {
  /**
   * WHAT: Pin that product docs and package metadata stay neutral about the
   * repository hosting provider.
   * WHY: Gitea/GitHub are CI and publishing implementation details here; source
   * content should not claim either host as the canonical project truth.
   */
  test("rejects provider-host source URLs outside CI configuration", () => {
    const issues = collectProviderHostReferenceIssues([
      {
        path: "docs/index.md",
        content: "Source: https://github.com/jensbodal/agents-js/tree/main/packages/cli",
      },
      {
        path: ".github/workflows/ci.yml",
        content: "CI provider config may keep implementation-specific source URLs.",
      },
    ]);

    expect(issues).toEqual([
      "docs/index.md: contains provider-host source URL: https://github.com/jensbodal/agents-js/tree/main/packages/cli",
    ]);
  });

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
   * WHAT: Pin that consistency checks reference current documentation paths
   * rather than removed historical pages.
   * WHY: A stale docs/contribute.md expectation caused the consistency script to
   * fail before it could report real semantic drift.
   */
  test("rejects removed documentation paths in docs consistency expectations", () => {
    const issues = collectRemovedDocPathIssues([
      {
        path: "README.md",
        content: "See docs/protocol-alignment.md, then docs/develop/contribute.md.",
      },
    ]);

    expect(issues).toEqual([
      "README.md: references removed documentation path: docs/protocol-alignment.md",
    ]);
  });

  /**
   * WHAT: Pin that optional local-operator files are checked when present but
   * do not make docs consistency fail on clean worktrees where they are absent.
   * WHY: The `.factory` operator notes are local workspace context, not tracked
   * repo content; requiring them made `bun run check` depend on untracked files.
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
});
