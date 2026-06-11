import { describe, expect, test } from "bun:test";
import {
  type ChangedFile,
  erroredEvaluation,
  evaluateDocsOnlyGuard,
  globToRegExp,
  isDocsContent,
  isSensitive,
} from "../src/docs-only-path-guard.ts";
import { DOCS_ONLY_POLICY_V0 } from "../src/docs-only-policy.ts";

const f = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  changeKind: "modified",
  ...over,
});

describe("globToRegExp", () => {
  test("dir/** matches anything under the dir, recursively", () => {
    expect(globToRegExp(".github/workflows/**").test(".github/workflows/ci.yml")).toBe(true);
    expect(globToRegExp("packages/policy/**").test("packages/policy/src/x.ts")).toBe(true);
    expect(globToRegExp("packages/policy/**").test("packages/other/x.ts")).toBe(false);
  });

  test("docs/**/*.md matches md at any depth under docs/", () => {
    const re = globToRegExp("docs/**/*.md");
    expect(re.test("docs/a.md")).toBe(true);
    expect(re.test("docs/x/y/z.md")).toBe(true);
    expect(re.test("docs/a.mdx")).toBe(false);
    expect(re.test("packages/a.md")).toBe(false);
  });

  test("**/seg/** matches an interior path segment", () => {
    const re = globToRegExp("**/test/**");
    expect(re.test("packages/foo/test/fixtures/sample.md")).toBe(true);
    expect(re.test("test/x.md")).toBe(true);
    expect(re.test("packages/foo/src/x.ts")).toBe(false);
  });

  test("exact path matches exactly, with metachars escaped", () => {
    expect(globToRegExp("README.md").test("README.md")).toBe(true);
    expect(globToRegExp("README.md").test("READMEXmd")).toBe(false);
    expect(globToRegExp("docs/a.b").test("docs/aXb")).toBe(false);
  });
});

describe("evaluateDocsOnlyGuard — lane proof", () => {
  test("proven docs-only: only docs markdown", () => {
    const r = evaluateDocsOnlyGuard([f("docs/guide.md"), f("docs/api/ref.md")]);
    expect(r.lane).toBe("docs-only");
    expect(r.guardResult).toBe("proven");
    expect(r.unmatchedPaths).toEqual([]);
    expect(r.policyVersion).toBe(DOCS_ONLY_POLICY_V0.version);
  });

  test("enumerated root prose is docs-only; non-enumerated root .md is NOT", () => {
    expect(evaluateDocsOnlyGuard([f("README.md")]).lane).toBe("docs-only");
    // bare **/*.md is deliberately NOT allowlisted (markdown-as-data guard)
    expect(evaluateDocsOnlyGuard([f("NOTES.md")]).lane).toBe("full-lane");
  });

  test("default-deny: one non-docs file forces full-lane and is named in unmatched", () => {
    const r = evaluateDocsOnlyGuard([f("docs/guide.md"), f("packages/host/src/x.ts")]);
    expect(r.lane).toBe("full-lane");
    expect(r.guardResult).toBe("not-proven");
    expect(r.unmatchedPaths).toEqual(["packages/host/src/x.ts"]);
    expect(r.matchedPaths).toEqual(["docs/guide.md"]);
  });

  test("empty diff → not-proven → full-lane", () => {
    const r = evaluateDocsOnlyGuard([]);
    expect(r.lane).toBe("full-lane");
    expect(r.guardResult).toBe("not-proven");
  });
});

describe("evaluateDocsOnlyGuard — load-bearing adversarial escapes", () => {
  test("docs-infra escape: a workflow file is never docs-only", () => {
    expect(evaluateDocsOnlyGuard([f(".gitea/workflows/docs.yml")]).lane).toBe("full-lane");
    expect(evaluateDocsOnlyGuard([f("mkdocs.yml")]).lane).toBe("full-lane");
    expect(evaluateDocsOnlyGuard([f("docs/build.sh")]).lane).toBe("full-lane");
    expect(evaluateDocsOnlyGuard([f("docs/conf.py")]).lane).toBe("full-lane");
  });

  test("symlink escape: mode 120000 under docs/ is non-docs", () => {
    const r = evaluateDocsOnlyGuard([f("docs/link", { mode: "120000" })]);
    expect(r.lane).toBe("full-lane");
    expect(r.unmatchedPaths).toEqual(["docs/link"]);
  });

  test("rename escape: code→docs rename checks BOTH endpoints", () => {
    const r = evaluateDocsOnlyGuard([
      f("docs/secret.md", { changeKind: "renamed", oldPath: "packages/host/src/secret.ts" }),
    ]);
    expect(r.lane).toBe("full-lane");
    expect(r.guardResult).toBe("not-proven");
  });

  test("rename within docs IS docs-only (both endpoints docs-content)", () => {
    const r = evaluateDocsOnlyGuard([
      f("docs/new.md", { changeKind: "renamed", oldPath: "docs/old.md" }),
    ]);
    expect(r.lane).toBe("docs-only");
  });

  test("markdown-as-data: test-fixture markdown is excluded from docs-only", () => {
    expect(evaluateDocsOnlyGuard([f("packages/foo/test/fixtures/sample.md")]).lane).toBe(
      "full-lane",
    );
    expect(isDocsContent(f("packages/foo/__snapshots__/x.md"), DOCS_ONLY_POLICY_V0)).toBe(false);
  });
});

describe("evaluateDocsOnlyGuard — deterministic security escalation", () => {
  test("sensitive-path denylist sets human review WITHOUT an agent", () => {
    const r = evaluateDocsOnlyGuard([f("packages/policy/src/permission-engine.ts")]);
    expect(r.lane).toBe("full-lane");
    expect(r.humanReviewRequired).toBe(true);
    expect(r.sensitivePaths).toEqual(["packages/policy/src/permission-engine.ts"]);
  });

  test("a rename OUT of a sensitive path still flags sensitive (old endpoint)", () => {
    expect(
      isSensitive(
        f("docs/moved.md", { changeKind: "renamed", oldPath: "packages/policy/src/x.ts" }),
        DOCS_ONLY_POLICY_V0,
      ),
    ).toBe(true);
  });

  test("docs-only PR with no sensitive paths does not require human review", () => {
    expect(evaluateDocsOnlyGuard([f("docs/guide.md")]).humanReviewRequired).toBe(false);
  });
});

describe("evaluateDocsOnlyGuard — fail-closed error path", () => {
  test("errored is distinct from not-proven, still full-lane", () => {
    const r = erroredEvaluation("missing base SHA");
    expect(r.lane).toBe("full-lane");
    expect(r.guardResult).toBe("errored");
    expect(r.erroredReason).toBe("missing base SHA");
  });
});
