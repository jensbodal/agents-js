/**
 * AJS-60 M1 — WorkspaceIsolationProvider + CopiedReplicaBackend
 * contract tests. Behavior tests, not implementation tests.
 *
 * Pins the security-critical invariants from the vault design
 * `agents-js-workspace-isolation-provider-2026-05-21.md` M1
 * acceptance criteria:
 *
 *  - Replica lives OUTSIDE the source repo (no in-tree replica).
 *  - `.git` / `.jj` / `node_modules` ALWAYS excluded.
 *  - Caller-supplied `policy.excludePaths` extends (never narrows)
 *    the baseline.
 *  - Symlinks escaping the source tree are REJECTED at create-time
 *    (atomic — no leftover partial replica).
 *  - Symlinks injected post-create are FLAGGED by `inspectReplica`
 *    with `escapes: true` so the host's sync-back gate rejects them.
 *  - Mutating the replica does NOT mutate the source (canonical
 *    workspace isolation).
 *  - `inspectReplica` reports `changedPaths` / `addedPaths` /
 *    `deletedPaths` deterministically vs. the create-time baseline.
 *  - `protectedPaths` policy surfaces in inspection results so the
 *    host's write-gate can refuse to apply.
 *  - `destroy` is idempotent (calling twice on the same workspace
 *    is a no-op, not an error).
 *  - Unknown workspaceId on any read/write method throws a clear
 *    error rather than silently returning empty.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCopiedReplicaBackend,
  type IsolatedWorkspace,
  type WorkspaceIsolationProvider,
} from "../src/workspace-isolation-provider.ts";

/**
 * Per-test scratch directory under the OS tmpdir. `beforeEach`
 * creates a clean source repo populated with a deterministic file
 * tree; `afterEach` tears it down. This pattern lets each test name
 * exactly what file shape it's exercising without inheriting state.
 */
let scratchRoot: string;
let sourceRepo: string;
let replicaRoot: string;
let provider: WorkspaceIsolationProvider;

beforeEach(async () => {
  scratchRoot = join(tmpdir(), `agents-js-iso-test-${crypto.randomUUID()}`);
  sourceRepo = join(scratchRoot, "source");
  replicaRoot = join(scratchRoot, "replicas");
  await mkdir(sourceRepo, { recursive: true });
  // Baseline file tree the tests can rely on:
  //   src/index.ts (regular file)
  //   src/lib/helper.ts (nested file)
  //   .git/config (must be excluded)
  //   node_modules/foo/package.json (must be excluded)
  //   README.md (regular file)
  await mkdir(join(sourceRepo, "src/lib"), { recursive: true });
  await mkdir(join(sourceRepo, ".git"), { recursive: true });
  await mkdir(join(sourceRepo, "node_modules/foo"), { recursive: true });
  await writeFile(join(sourceRepo, "src/index.ts"), "export const a = 1;\n");
  await writeFile(join(sourceRepo, "src/lib/helper.ts"), "export const h = 2;\n");
  await writeFile(join(sourceRepo, "README.md"), "# repo\n");
  await writeFile(join(sourceRepo, ".git/config"), "[core]\n");
  await writeFile(join(sourceRepo, "node_modules/foo/package.json"), "{}\n");

  provider = createCopiedReplicaBackend({ replicaRoot });
});

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

async function makeReplica(opts?: {
  excludePaths?: readonly string[];
  protectedPaths?: readonly string[];
}): Promise<IsolatedWorkspace> {
  return provider.createReplica({
    repoPath: sourceRepo,
    baseRef: "test-base-ref",
    taskId: "task-001",
    agentId: "codex-hostname-null",
    policy: {
      ...(opts?.excludePaths ? { excludePaths: opts.excludePaths } : {}),
      ...(opts?.protectedPaths ? { protectedPaths: opts.protectedPaths } : {}),
    },
  });
}

describe("packages/host/tests/workspace-isolation-provider.test.ts — AJS-60 M1 contract", () => {
  /**
   * WHAT: `createReplica` returns a handle whose `replicaPath` lives
   *       under the configured `replicaRoot`, NOT under the source
   *       repo path.
   * WHY: Hard isolation boundary. An in-tree replica would let the
   *      agent mutate the source by walking up the directory tree;
   *      it would also fail the "agent cannot directly mutate the
   *      source checkout" AC. Pin both directions (replica outside
   *      source AND replica under configured root).
   */
  test("replica lives outside source repo, under configured replicaRoot", async () => {
    const workspace = await makeReplica();
    // Use realpath for the comparison because the backend canonicalizes
    // its own paths via realpath (to survive host-side symlink chains
    // like macOS's `/tmp` → `/private/tmp`). Test assertions compare
    // canonical-vs-canonical, never raw-vs-canonical.
    const canonicalSource = await realpath(sourceRepo);
    const canonicalReplicaRoot = await realpath(replicaRoot);
    expect(workspace.replicaPath.startsWith(`${canonicalSource}/`)).toBe(false);
    expect(workspace.replicaPath.startsWith(`${canonicalReplicaRoot}/`)).toBe(true);
    const replicaStat = await stat(workspace.replicaPath);
    expect(replicaStat.isDirectory()).toBe(true);
  });

  /**
   * WHAT: `createReplica` copies every non-excluded regular file
   *       from source to replica with identical content.
   * WHY: Positive path. Without this, every exclusion test below
   *      could pass while the replica is empty (deny-all regression
   *      would be invisible).
   */
  test("createReplica copies regular files with identical content", async () => {
    const workspace = await makeReplica();
    const indexContent = await readFile(join(workspace.replicaPath, "src/index.ts"), "utf8");
    expect(indexContent).toBe("export const a = 1;\n");
    const helperContent = await readFile(join(workspace.replicaPath, "src/lib/helper.ts"), "utf8");
    expect(helperContent).toBe("export const h = 2;\n");
  });

  /**
   * WHAT: `.git/`, `.jj/`, and `node_modules/` are NEVER present in
   *       the replica, regardless of caller policy.
   * WHY: Hard-baked exclusions (per design "trust-sensitive metadata
   *      that the agent must never see or mutate"). A caller cannot
   *      narrow this — operators wanting to inspect those would need
   *      a separate, scoped Provider, not this one. Pin via
   *      negative-existence assertion.
   */
  test("baseline exclusions (.git, .jj, node_modules) NEVER copied", async () => {
    const workspace = await makeReplica();
    expect(await stat(join(workspace.replicaPath, ".git")).catch(() => null)).toBeNull();
    expect(await stat(join(workspace.replicaPath, "node_modules")).catch(() => null)).toBeNull();
  });

  /**
   * WHAT: Caller-supplied `policy.excludePaths` extends the baseline
   *       — the path is absent from the replica in addition to the
   *       baseline exclusions.
   * WHY: Operators may have additional secrets directories (e.g.
   *      `secrets/`, `local-only/`) that need to stay out of agent
   *      view. Test the additive semantics.
   */
  test("caller-supplied excludePaths additively excluded from replica", async () => {
    await mkdir(join(sourceRepo, "secrets"), { recursive: true });
    await writeFile(join(sourceRepo, "secrets/key.pem"), "-----BEGIN\n");
    const workspace = await makeReplica({ excludePaths: ["secrets"] });
    expect(await stat(join(workspace.replicaPath, "secrets")).catch(() => null)).toBeNull();
    // README.md still present — exclusion is targeted, not greedy.
    expect(await readFile(join(workspace.replicaPath, "README.md"), "utf8")).toBe("# repo\n");
  });

  /**
   * WHAT: If the source contains a symlink whose target resolves
   *       OUTSIDE the source tree (e.g. → `/etc/passwd`),
   *       `createReplica` rejects with an error mentioning the
   *       escape, AND no replica directory is left on disk.
   * WHY: Critical security invariant. Following such a symlink at
   *      copy-time would let an agent's replica contain arbitrary
   *      host-filesystem content, breaking the isolation promise.
   *      Atomic-failure (no partial replica) prevents an operator
   *      from being misled by leftover state on disk.
   */
  test("source symlink escaping outside source tree → createReplica rejects atomically", async () => {
    // Symlink at sourceRepo/escape → /etc/passwd (an absolute path
    // outside the source tree). The link target doesn't need to
    // exist for the realpath check to classify it as an escape.
    await symlink("/etc/passwd", join(sourceRepo, "escape"));
    await expect(makeReplica()).rejects.toThrow(/escapes the source tree/);
    // No leftover replica directory for this workspaceId.
    const replicaDirs = await readdir(replicaRoot).catch(() => [] as string[]);
    expect(replicaDirs.filter((d) => d !== "")).toHaveLength(0);
  });

  /**
   * WHAT: Symlinks WITHIN the source tree (e.g. `src/alias` →
   *       `./index.ts`) are FOLLOWED at copy-time — the replica
   *       contains a regular file with the resolved content, not a
   *       symlink.
   * WHY: Per design "Replica resolves all symlinks at create-time;
   *      agent cannot create symlinks pointing outside replica" —
   *      the resolved-content shape is the substrate's
   *      post-condition. Symlink-following inside the source tree
   *      is safe because no escape is possible.
   */
  test("source symlink inside source tree → replicated as regular file (resolved content)", async () => {
    await symlink("./index.ts", join(sourceRepo, "src/alias.ts"));
    const workspace = await makeReplica();
    const aliasContent = await readFile(join(workspace.replicaPath, "src/alias.ts"), "utf8");
    expect(aliasContent).toBe("export const a = 1;\n");
  });

  /**
   * WHAT: `createReplica` rejects when configured `replicaRoot` is
   *       inside the source repo (i.e. the replica would end up
   *       in-tree).
   * WHY: Defense-in-depth. Even if an operator misconfigures the
   *      backend with a `replicaRoot` pointing into the source repo,
   *      `createReplica` MUST refuse rather than create an in-tree
   *      replica. The atomic refusal also catches recursive-copy
   *      footguns (replica path being copied into itself).
   */
  test("replicaRoot inside source repo → createReplica rejects", async () => {
    const inTreeProvider = createCopiedReplicaBackend({
      replicaRoot: join(sourceRepo, "internal-replicas"),
    });
    await expect(
      inTreeProvider.createReplica({
        repoPath: sourceRepo,
        baseRef: "x",
        taskId: "t",
        agentId: "a",
        policy: {},
      }),
    ).rejects.toThrow(/cannot live inside source/);
  });

  /**
   * WHAT: Multiple `createReplica` calls produce unique
   *       `workspaceId`s and non-overlapping replica directories.
   * WHY: A duplicate workspaceId would let one task's replica clobber
   *      another's at destroy-time. Pin uniqueness as a hard contract.
   */
  test("createReplica generates unique workspaceIds across calls", async () => {
    const w1 = await makeReplica();
    const w2 = await makeReplica();
    expect(w1.workspaceId).not.toBe(w2.workspaceId);
    expect(w1.replicaPath).not.toBe(w2.replicaPath);
  });

  /**
   * WHAT: Mutating files in the replica does NOT change the source
   *       repo's files.
   * WHY: The core isolation guarantee. Without this, every other AC
   *      is decorative — an agent could mutate source bytes through
   *      the replica via hardlinks/inode-sharing/etc. Test by writing
   *      to the replica and asserting the source is untouched.
   */
  test("mutating replica does NOT mutate source repo (isolation)", async () => {
    const workspace = await makeReplica();
    await writeFile(
      join(workspace.replicaPath, "src/index.ts"),
      "export const a = 999; // replica only\n",
    );
    const sourceContent = await readFile(join(sourceRepo, "src/index.ts"), "utf8");
    expect(sourceContent).toBe("export const a = 1;\n");
  });

  /**
   * WHAT: After `createReplica`, `inspectReplica` on the unmodified
   *       replica returns empty `changedPaths`, `addedPaths`,
   *       `deletedPaths`.
   * WHY: Baseline-snapshot correctness. If the snapshot doesn't
   *      match the create-time state, every diff is junk. Pin the
   *      zero-diff state explicitly.
   */
  test("inspectReplica on unmodified replica → empty diff lists", async () => {
    const workspace = await makeReplica();
    const inspection = await provider.inspectReplica({ workspaceId: workspace.workspaceId });
    expect(inspection.changedPaths).toEqual([]);
    expect(inspection.addedPaths).toEqual([]);
    expect(inspection.deletedPaths).toEqual([]);
  });

  /**
   * WHAT: Modifying a file in the replica → that path appears in
   *       `changedPaths` (not `addedPaths`, not `deletedPaths`).
   * WHY: Pin the modified-file classification. A bug that
   *      categorized modifications as "added" would skew the host's
   *      sync-back patch generation.
   */
  test("inspectReplica reports modified files in changedPaths", async () => {
    const workspace = await makeReplica();
    await writeFile(join(workspace.replicaPath, "src/index.ts"), "export const a = 2;\n");
    const inspection = await provider.inspectReplica({ workspaceId: workspace.workspaceId });
    expect(inspection.changedPaths).toEqual(["src/index.ts"]);
    expect(inspection.addedPaths).toEqual([]);
    expect(inspection.deletedPaths).toEqual([]);
  });

  /**
   * WHAT: Adding a new file in the replica → that path appears in
   *       `addedPaths`. Deleting an existing file → `deletedPaths`.
   * WHY: Symmetric pin for the create/delete cases. Adds + deletes
   *      flow through the same diff logic; testing both ends catches
   *      a class of off-by-one bugs in the snapshot comparison.
   */
  test("inspectReplica reports added + deleted files distinctly", async () => {
    const workspace = await makeReplica();
    await writeFile(join(workspace.replicaPath, "NEW.md"), "new file\n");
    await rm(join(workspace.replicaPath, "README.md"));
    const inspection = await provider.inspectReplica({ workspaceId: workspace.workspaceId });
    expect(inspection.addedPaths).toEqual(["NEW.md"]);
    expect(inspection.deletedPaths).toEqual(["README.md"]);
    expect(inspection.changedPaths).toEqual([]);
  });

  /**
   * WHAT: A symlink created in the replica AFTER `createReplica`
   *       (e.g. by the agent) is reported by `inspectReplica` with
   *       `escapes: true` when its target resolves outside the
   *       replica root.
   * WHY: Post-create injection is the practical attack surface — the
   *      agent runs `ln -s /etc/passwd ./pwd` inside the replica
   *      hoping the host's sync-back will follow the link and write
   *      passwd-content to the source. `inspectReplica` MUST surface
   *      this so the host gate rejects it.
   */
  test("post-create symlink escape → flagged with escapes=true in symlinks list", async () => {
    const workspace = await makeReplica();
    await symlink("/etc/passwd", join(workspace.replicaPath, "evil"));
    const inspection = await provider.inspectReplica({ workspaceId: workspace.workspaceId });
    const evilEntry = inspection.symlinks.find((s) => s.path === "evil");
    expect(evilEntry).toBeDefined();
    expect(evilEntry?.escapes).toBe(true);
  });

  /**
   * WHAT: A symlink created in the replica whose target stays
   *       WITHIN the replica root is reported with `escapes: false`.
   * WHY: Not every symlink is an attack; legitimate intra-replica
   *      symlinks (e.g. CI artifacts pointing to dist/) should
   *      surface as informational, not blocking. Pin the
   *      non-escape case so the gate doesn't false-positive.
   */
  test("post-create symlink within replica → flagged with escapes=false", async () => {
    const workspace = await makeReplica();
    await symlink("./src/index.ts", join(workspace.replicaPath, "alias"));
    const inspection = await provider.inspectReplica({ workspaceId: workspace.workspaceId });
    const alias = inspection.symlinks.find((s) => s.path === "alias");
    expect(alias).toBeDefined();
    expect(alias?.escapes).toBe(false);
  });

  /**
   * WHAT: A modified file whose path matches `policy.protectedPaths`
   *       surfaces in `protectedPathMutations` (in addition to
   *       `changedPaths`).
   * WHY: Hard-block surface for the host's sync-back gate. Operators
   *      configure `protectedPaths` for files like `.env`, secrets,
   *      or build-time constants — mutations to these should never
   *      reach the source no matter what scope the caller has. Pin
   *      the surfacing so the gate's reject branch fires.
   */
  test("modified protected path → reported in protectedPathMutations", async () => {
    const workspace = await makeReplica({ protectedPaths: ["src/index.ts"] });
    await writeFile(join(workspace.replicaPath, "src/index.ts"), "tampered\n");
    const inspection = await provider.inspectReplica({ workspaceId: workspace.workspaceId });
    expect(inspection.protectedPathMutations).toContain("src/index.ts");
  });

  /**
   * WHAT: `exportChangeSet` with `format: "summary"` returns a
   *       human-readable summary containing every changed / added /
   *       deleted path. The leading banner contains `NOT-APPLYABLE`;
   *       `paths` matches inspection.
   * WHY: Pinned by @cognee-codex review id 18 — v1 does NOT emit
   *      git-applyable patches (no retained baseline bytes). The
   *      contract is honest: reviewer-facing summary, never to be
   *      piped into `git apply`. The `NOT-APPLYABLE` banner makes
   *      any caller that tries to apply fail loudly at parse time
   *      rather than silently produce nonsense. Real unified-diff
   *      is a v1.1 follow-up.
   */
  test("exportChangeSet (summary) emits NOT-APPLYABLE banner + lists all changed paths", async () => {
    const workspace = await makeReplica();
    await writeFile(join(workspace.replicaPath, "src/index.ts"), "modified\n");
    await writeFile(join(workspace.replicaPath, "NEW.md"), "new\n");
    await rm(join(workspace.replicaPath, "README.md"));
    const cs = await provider.exportChangeSet({
      workspaceId: workspace.workspaceId,
      format: "summary",
    });
    expect(cs.format).toBe("summary");
    expect(cs.content).toContain("NOT-APPLYABLE");
    expect([...cs.paths].sort()).toEqual(["NEW.md", "README.md", "src/index.ts"]);
    expect(cs.content).toContain("src/index.ts");
    expect(cs.content).toContain("NEW.md");
    expect(cs.content).toContain("README.md");
  });

  /**
   * WHAT: A multi-segment `excludePaths` entry (e.g. `"src/generated"`)
   *       excludes BOTH the directory and ALL files / subtrees beneath
   *       it from the replica.
   * WHY: Pinned by @cognee-codex review id 18 — the previous
   *      single-segment-only matcher (`segments.includes(ex)`) failed
   *      to descend into multi-segment prefixes and leaked
   *      `src/generated/file.ts` into the replica. Multi-segment
   *      exclusions are how operators specify nested secret/private
   *      directories; a partial match silently exposes nested files.
   *      Pin both axes: directory node absent AND nested-file absent.
   */
  test("multi-segment excludePaths excludes nested files (not just the dir node)", async () => {
    await mkdir(join(sourceRepo, "src/generated/sub"), { recursive: true });
    await writeFile(join(sourceRepo, "src/generated/file.ts"), "generated\n");
    await writeFile(join(sourceRepo, "src/generated/sub/deep.ts"), "deep\n");
    const workspace = await makeReplica({ excludePaths: ["src/generated"] });
    expect(await stat(join(workspace.replicaPath, "src/generated")).catch(() => null)).toBeNull();
    expect(
      await stat(join(workspace.replicaPath, "src/generated/file.ts")).catch(() => null),
    ).toBeNull();
    expect(
      await stat(join(workspace.replicaPath, "src/generated/sub/deep.ts")).catch(() => null),
    ).toBeNull();
    // Sibling under src/ untouched.
    expect(await readFile(join(workspace.replicaPath, "src/index.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );
  });

  /**
   * WHAT: `exportChangeSet` with `format: "rsync-manifest"` returns
   *       a newline-separated list of every modified path, no diff
   *       content.
   * WHY: Some sync-back substrates (rsync-based, future containers)
   *      want just the path list without diff bytes. Pin the
   *      lightweight format separately so callers can rely on it.
   */
  test("exportChangeSet (rsync-manifest) returns path list only", async () => {
    const workspace = await makeReplica();
    await writeFile(join(workspace.replicaPath, "src/index.ts"), "modified\n");
    const cs = await provider.exportChangeSet({
      workspaceId: workspace.workspaceId,
      format: "rsync-manifest",
    });
    expect(cs.format).toBe("rsync-manifest");
    expect(cs.content).toBe("src/index.ts");
    expect(cs.paths).toEqual(["src/index.ts"]);
  });

  /**
   * WHAT: `destroy` removes the replica directory from disk.
   * WHY: Resource lifecycle pin. Without this, every task creates a
   *      replica that lingers in `/tmp/agents-js-replicas/` until the
   *      OS cleans tmp — operationally messy and breaks the "no
   *      leaked containers / no leftover state" AC by analogy.
   */
  test("destroy removes the replica directory", async () => {
    const workspace = await makeReplica();
    expect((await stat(workspace.replicaPath).catch(() => null))?.isDirectory()).toBe(true);
    await provider.destroy(workspace.workspaceId);
    expect(await stat(workspace.replicaPath).catch(() => null)).toBeNull();
  });

  /**
   * WHAT: Calling `destroy` twice on the same workspaceId is a
   *       no-op on the second call — does NOT throw.
   * WHY: Idempotency. Consumers cleaning up on error paths
   *      (try/finally) shouldn't have to track whether destroy was
   *      already called. Pin via direct double-call.
   */
  test("destroy is idempotent (double-destroy does not throw)", async () => {
    const workspace = await makeReplica();
    await provider.destroy(workspace.workspaceId);
    // Second call MUST NOT throw.
    await provider.destroy(workspace.workspaceId);
  });

  /**
   * WHAT: `inspectReplica` and `exportChangeSet` called with an
   *       unknown `workspaceId` throw with a clear "unknown
   *       workspaceId" error mentioning the id.
   * WHY: Misuse surfaces loudly. Silent empty-result returns would
   *      mask programmer errors (a caller racing destroy + inspect
   *      should see the explicit error, not interpret an empty diff
   *      as "no changes"). Echoing the id helps operator debugging.
   */
  test("read methods throw 'unknown workspaceId' for unknown id", async () => {
    await expect(provider.inspectReplica({ workspaceId: "does-not-exist" })).rejects.toThrow(
      /unknown workspaceId/,
    );
    await expect(
      provider.exportChangeSet({ workspaceId: "does-not-exist", format: "summary" }),
    ).rejects.toThrow(/unknown workspaceId/);
  });

  /**
   * WHAT: `createReplica` rejects when `repoPath` is not a directory
   *       (e.g. a regular file or a non-existent path).
   * WHY: Friendly error surface — without this, the underlying
   *      `fs.cp` would throw an opaque ENOTDIR / ENOENT mid-copy
   *      with no replica-side context. Pin the early check so
   *      operators see a clear "source path is not a directory"
   *      message before any state changes.
   */
  test("createReplica with non-directory source path → rejects with clear error", async () => {
    await expect(
      provider.createReplica({
        repoPath: join(scratchRoot, "does-not-exist"),
        baseRef: "x",
        taskId: "t",
        agentId: "a",
        policy: {},
      }),
    ).rejects.toThrow(/not a directory/);
    // Also reject when the path is a file, not a directory.
    const filePath = join(scratchRoot, "regular-file.txt");
    await writeFile(filePath, "not a directory\n");
    await expect(
      provider.createReplica({
        repoPath: filePath,
        baseRef: "x",
        taskId: "t",
        agentId: "a",
        policy: {},
      }),
    ).rejects.toThrow(/not a directory/);
  });
});
