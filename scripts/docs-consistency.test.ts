import { describe, expect, test } from "bun:test";
import {
  collectFileExpectationIssues,
  collectFrontmatterTagIssues,
  collectGraphPackageIssues,
  collectPendingExtractionBreadcrumbIssues,
  collectProviderHostReferenceIssues,
  collectRemovedDocPathIssues,
} from "./docs-consistency.ts";

describe("docs-consistency", () => {
  /**
   * WHAT: Pin that product docs and package metadata stay neutral about the
   * repository hosting provider.
   * WHY: repository hosting and CI providers are implementation details here; source
   * content should not claim either host as the canonical project truth.
   */
  test("rejects provider-host source URLs outside CI configuration", () => {
    const issues = collectProviderHostReferenceIssues([
      {
        path: "docs/index.md",
        content: "Source: https://github.com/example/agents-js/tree/main/packages/cli",
      },
      {
        path: ".github/workflows/ci.yml",
        content: "CI provider config may keep implementation-specific source URLs.",
      },
    ]);

    expect(issues).toEqual([
      "docs/index.md: contains provider-host source URL: https://github.com/example/agents-js/tree/main/packages/cli",
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
   * WHAT: Pin that consistency checks do not reference retired documentation paths.
   * WHY: A stale docs/contribute.md expectation caused the consistency script to
   * fail before it could report real semantic drift.
   */
  test("rejects retired documentation paths in docs consistency expectations", () => {
    const issues = collectRemovedDocPathIssues([
      {
        path: "README.md",
        content: "See docs/protocol-alignment.md, then docs/develop/contribute.md.",
      },
    ]);

    expect(issues).toEqual([
      "README.md: references retired documentation path: docs/protocol-alignment.md",
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
   * via a `diataxis:` frontmatter tag drawn from a closed set, and that
   * pages tagged `reference` either transclude generated content or carry a
   * tracked entry in the pending-extraction allowlist.
   * WHY: Reference content authored as prose is the structural drift this
   * docs-governance reframe targets; the gate ensures the contract is
   * machine-checked rather than reviewer-enforced.
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
        referenceIndexExempt: ["_generated/README.md"],
        pendingExtraction: [{ page: "protocols.md", blockedBy: "Port 6" }],
      },
      async (relative) => {
        switch (relative) {
          case "docs/_generated/README.md":
            return "---\ntitle: Index\ndiataxis: reference\n---\n";
          case "docs/getting-started.md":
            return "---\ntitle: Getting Started\ndiataxis: tutorial\n---\n";
          case "docs/harness-guide.md":
            return "---\ndiataxis: howto\n---\n\n!!!include(_generated/foo.md)!!!\n";
          case "docs/protocols.md":
            return "---\ndiataxis: reference\n---\n\nNo includes yet (allowlisted).\n";
          default:
            throw new Error(`unexpected read: ${relative}`);
        }
      },
    );

    expect(issues).toEqual([]);
  });

  test("collectFrontmatterTagIssues — flags missing tag, invalid tag, and reference without include", async () => {
    const issues = await collectFrontmatterTagIssues(
      {
        handAuthoredPages: ["no-frontmatter.md", "wrong-tag.md", "ref-no-include.md"],
      },
      async (relative) => {
        switch (relative) {
          case "docs/no-frontmatter.md":
            return "# Just markdown, no frontmatter\n";
          case "docs/wrong-tag.md":
            return "---\ndiataxis: deepDive\n---\n";
          case "docs/ref-no-include.md":
            return "---\ndiataxis: reference\n---\n\nProse only.\n";
          default:
            throw new Error(`unexpected read: ${relative}`);
        }
      },
    );

    expect(issues).toEqual([
      "docs/no-frontmatter.md: missing frontmatter (must include a 'diataxis:' tag)",
      "docs/wrong-tag.md: 'diataxis: deepDive' is not a valid Diátaxis tag (allowed: explanation, howto, landing, reference, tutorial)",
      "docs/ref-no-include.md: tagged 'diataxis: reference' but contains no include directive (!!!include(...)!!! or <<< @/...). Add the include or list it under docs/.manifest.json#pendingExtraction with the blocking port.",
    ]);
  });

  /**
   * WHAT: Pin that section-level pendingExtraction entries are
   * cross-validated against `<!-- pending-extraction: <token> -->`
   * HTML breadcrumbs in the page; missing breadcrumbs and orphan
   * breadcrumbs both surface as drift.
   * WHY: Section-level deferrals are tracked in the manifest as the
   * single source of truth; the breadcrumb in the page is the
   * discoverable evidence a future reviewer hits when reading the
   * stale section. Either side missing means the cross-reference
   * is broken.
   */
  test("collectPendingExtractionBreadcrumbIssues — flags missing and orphan breadcrumbs", async () => {
    const issues = await collectPendingExtractionBreadcrumbIssues(
      {
        handAuthoredPages: ["a.md", "b.md", "c.md"],
        pendingExtraction: [
          { page: "a.md", section: "expected-here", blockedBy: "Port X" },
          { page: "missing-breadcrumb.md", section: "ghost", blockedBy: "Port Y" },
        ],
      },
      async (relative) => {
        switch (relative) {
          case "docs/a.md":
            return "<!-- pending-extraction: expected-here -->\n# Page A\n";
          case "docs/b.md":
            return "<!-- pending-extraction: orphan-token -->\n# Page B\n";
          case "docs/c.md":
            return "# Page C, no breadcrumbs\n";
          case "docs/missing-breadcrumb.md":
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          default:
            throw new Error(`unexpected read: ${relative}`);
        }
      },
    );

    expect(issues).toEqual([
      "docs/b.md: contains <!-- pending-extraction: orphan-token --> breadcrumb but the manifest has no matching pendingExtraction entry",
    ]);
  });

  test("collectFrontmatterTagIssues — rejects allowlist entries that are not real hand-authored pages", async () => {
    const issues = await collectFrontmatterTagIssues(
      {
        handAuthoredPages: ["a.md"],
        pendingExtraction: [{ page: "ghost.md", blockedBy: "Phantom port" }],
      },
      async () => "---\ndiataxis: explanation\n---\n",
    );

    // Allowlist mismatch is reported in addition to whatever per-page errors
    // surface; the entry-not-real check protects against silent typos.
    expect(issues).toContain(
      'docs/.manifest.json: pendingExtraction lists "ghost.md" (blocked by Phantom port) but it is not in handAuthoredPages',
    );
  });
});
