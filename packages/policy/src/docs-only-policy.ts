/**
 * Versioned, in-repo policy for the deterministic docs-only path guard (M1).
 *
 * This is the human-owned source of truth for which changed files prove the
 * `docs-only` lane, which docs-pathed files are *infrastructure* (and so force
 * `full-lane`), and which paths are security-sensitive (additive human review).
 *
 * Design source: M1 design packet — deterministic docs-only path-guard
 * (§4.3 allowlist/denylist, §4.5 sensitive denylist). The guard logic in
 * `docs-only-path-guard.ts` is deterministic over these rule sets; no runtime
 * or remote policy fetch is performed in M1.
 *
 * Matching semantics are intentionally explicit (not full glob) so the guard is
 * auditable: see {@link matchesPattern}.
 */

/** A versioned set of deterministic path rules. */
export interface DocsOnlyPolicy {
  /** Stamped into every guard verdict for reproducibility (`policy_version`). */
  readonly version: string;
  /**
   * Documentation *content* patterns. A changed file is docs-content only if it
   * matches one of these AND matches none of {@link docsInfraDenylist}.
   * Deliberately anchored — NEVER a bare `**​/*.md` (markdown-as-data, §4.3).
   */
  readonly allowlist: readonly string[];
  /**
   * Documentation *infrastructure* — files that are about docs but execute code
   * or change behavior (docs-site config, build scripts, CI workflows, test
   * fixtures / markdown-as-data). Matching here forces `full-lane` even under
   * an allowlisted path.
   */
  readonly docsInfraDenylist: readonly string[];
  /**
   * Deterministic security-sensitive paths. Matching sets
   * `human_review_required` WITHOUT an agent (§4.5). Additive: the advisory
   * classifier may also raise security-sensitive, but it can never clear this.
   */
  readonly sensitiveDenylist: readonly string[];
}

/**
 * The M1 default policy. Versioned in-repo (git is the version control); the
 * guard accepts an explicit policy override for tests and future iterations.
 *
 * Pattern syntax (see {@link matchesPattern}):
 * - `dir/**`            — anything under `dir/` (recursive)
 * - `**​/seg/**`         — any path containing the `seg` path-segment
 * - `*.ext` / `dir/**​/*.ext` — suffix match (optionally rooted)
 * - exact path          — exact string match
 */
export const DOCS_ONLY_POLICY_V0: DocsOnlyPolicy = {
  version: "docs-only-policy.v0",

  allowlist: [
    // Documentation content, anchored to the docs root.
    "docs/**/*.md",
    "docs/**/*.mdx",
    // Documentation static assets under the docs root.
    "docs/**/*.png",
    "docs/**/*.jpg",
    "docs/**/*.jpeg",
    "docs/**/*.gif",
    "docs/**/*.svg",
    "docs/**/*.webp",
    // Enumerated root prose (NOT a bare **/*.md glob — see docsInfraDenylist).
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
  ],

  docsInfraDenylist: [
    // Docs-site config / build — executes code.
    "docs/**/conf.py",
    "mkdocs.yml",
    "docusaurus.config.js",
    "docusaurus.config.ts",
    "docs/**/*.config.js",
    "docs/**/*.config.ts",
    // Any executable/script under a docs path.
    "docs/**/*.js",
    "docs/**/*.ts",
    "docs/**/*.py",
    "docs/**/*.sh",
    // CI/workflow files run arbitrary code regardless of nominal purpose.
    ".github/workflows/**",
    ".gitea/workflows/**",
    // Markdown-as-data: test fixtures / snapshots / runtime-read markdown.
    "**/test/**",
    "**/tests/**",
    "**/fixtures/**",
    "**/__snapshots__/**",
    // Release-affecting: changeset frontmatter declares the version bump.
    ".changeset/**",
  ],

  sensitiveDenylist: [
    // Permission / policy engine itself.
    "packages/policy/**",
    // CI / workflow definitions.
    ".github/workflows/**",
    ".gitea/workflows/**",
    // Auth / credential / secret-handling and signing/trust surfaces.
    "**/auth/**",
    "**/credentials/**",
    "**/secrets/**",
    "**/signing/**",
    "**/trust-manifest/**",
  ],
};
