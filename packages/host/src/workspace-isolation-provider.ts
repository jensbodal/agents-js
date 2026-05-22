/**
 * AJS-60 M1 — WorkspaceIsolationProvider + CopiedReplicaBackend.
 *
 * Host-layer execution-substrate seam: agents work on a REPLICA of the
 * canonical workspace and never mutate the source directly. The host
 * orchestrates apply-to-source via a separate write-gate that uses
 * `packages/policy/src/permission-engine.ts`; the Provider's
 * responsibility ends at producing a reviewable change-set.
 *
 * See vault design `agents-js-workspace-isolation-provider-2026-05-21.md`
 * for the three-plane architecture (control / execution / sync),
 * substrate matrix, and risk model. This module ships the M1 default
 * substrate: `CopiedReplicaBackend`.
 *
 * Why copied-replica and not git-worktree as the M1 default (per
 * @cognee-codex source review): git-worktree shares Git metadata and
 * object storage with the canonical source repo. For arbitrary shell-
 * capable agents, that's a substantial trust-boundary leak — an agent
 * could rewrite hooks, mutate refs, or corrupt object storage. A
 * copied replica with `.git` excluded at copy-time is the safer
 * baseline. `GitWorktreeBackend` is a v1.1 add-on once the constraint
 * tests are proven.
 *
 * Provider contract is deliberately narrow: `createReplica`,
 * `inspectReplica`, `exportChangeSet`, `destroy`. No `syncBack` — host
 * owns write authority. M2 (container substrates) and M3 (delivery-
 * router integration) reuse this seam without changing the interface.
 */

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

/**
 * Caller-supplied policy controlling what's copied into the replica
 * and what's flagged on inspection.
 */
export interface WorkspacePolicy {
  /**
   * Path patterns to EXCLUDE when copying from source to replica.
   * Matched as path prefixes relative to source root (e.g.
   * `"node_modules"` matches both `node_modules/` and
   * `packages/foo/node_modules/`). Always in addition to the
   * baseline exclusions (`.git`, `.jj`).
   */
  excludePaths?: readonly string[];
  /**
   * Paths that, if mutated in the replica, will be reported as
   * `protectedPathMutations` by `inspectReplica` (and rejected by
   * the host's sync-back gate). Examples: `.env*`, secrets files.
   * Matched as path prefixes relative to replica root.
   */
  protectedPaths?: readonly string[];
}

/** Handle returned from `createReplica`. */
export interface IsolatedWorkspace {
  workspaceId: string;
  /** Absolute path to the replica root on disk. Outside the source repo. */
  replicaPath: string;
  /** Git sha / opaque ref label captured by the caller at create-time. */
  baseRef: string;
  /** Caller-supplied agent identifier (e.g. JWT `sub`). */
  agentId: string;
  /** Caller-supplied task identifier. */
  taskId: string;
  /** ISO timestamp of replica creation. */
  createdAt: string;
}

/** Result shape for `inspectReplica`. */
export interface ReplicaInspectionResult {
  /** Paths (relative to replica root) whose content differs from the baseline. */
  changedPaths: readonly string[];
  /** Paths that were created in the replica but didn't exist in baseline. */
  addedPaths: readonly string[];
  /** Paths that existed in baseline but were deleted in the replica. */
  deletedPaths: readonly string[];
  /**
   * Symlinks present in the replica (added by the agent after copy,
   * since copy-time follows symlinks rather than preserving them).
   * `escapes: true` means the realpath of the target resolves OUTSIDE
   * the replica root — a critical security flag.
   */
  symlinks: readonly { path: string; target: string; escapes: boolean }[];
  /** Subset of `changedPaths` + `addedPaths` that match `policy.protectedPaths`. */
  protectedPathMutations: readonly string[];
}

/**
 * Result of `exportChangeSet`.
 *
 * **`format: "summary"`** — human-readable summary of what changed,
 * NOT a git-applyable patch. Lists each modified path with its
 * change kind (modified / added / deleted) and (for files where
 * baseline content was retained) the current replica content
 * inline. Use this for reviewer-facing display, not for
 * `git apply` / `patch -p1`. Pinned by @cognee-codex review id 18.
 *
 * **`format: "rsync-manifest"`** — newline-separated list of paths
 * only. Use this when the consumer just needs the set of mutated
 * files (e.g. to drive an rsync, a directory walk, or a
 * follow-up real-patch generation that re-reads source HEAD).
 *
 * A real git-applyable `format: "unified-diff"` is a v1.1 follow-up;
 * it requires retaining baseline bytes per file (not just hashes)
 * and either implementing a JS diff algorithm or shelling out to
 * `diff -u`. v1 ships honest contracts: `"summary"` says what it
 * is, `"rsync-manifest"` says what it is, and consumers know
 * not to apply either with `git apply`.
 */
export interface ChangeSet {
  format: "summary" | "rsync-manifest";
  /**
   * Summary text (for `format: "summary"`) — diff-shaped, NOT
   * git-applyable. Or newline-separated path list (for
   * `format: "rsync-manifest"`).
   */
  content: string;
  /** Same `changedPaths + addedPaths + deletedPaths` as inspection. */
  paths: readonly string[];
}

/** Input args to `createReplica`. */
export interface CreateReplicaInput {
  /** Absolute path to the source workspace. */
  repoPath: string;
  /** Opaque base-ref label (e.g. git sha). */
  baseRef: string;
  /** Caller task id (echoes into the IsolatedWorkspace handle). */
  taskId: string;
  /** Caller agent id (echoes into the IsolatedWorkspace handle). */
  agentId: string;
  /** Policy controlling exclusions + protected paths. */
  policy: WorkspacePolicy;
}

/**
 * The Provider seam. Implementations are substrate-specific
 * (`CopiedReplicaBackend` here; future `DockerBackend`,
 * `ProxmoxLXCBackend`, etc.). All substrate-bound state lives in the
 * concrete implementation; the interface is stateless.
 */
export interface WorkspaceIsolationProvider {
  readonly name: string;
  createReplica(input: CreateReplicaInput): Promise<IsolatedWorkspace>;
  inspectReplica(input: { workspaceId: string }): Promise<ReplicaInspectionResult>;
  exportChangeSet(input: {
    workspaceId: string;
    format: "summary" | "rsync-manifest";
  }): Promise<ChangeSet>;
  destroy(workspaceId: string): Promise<void>;
}

/**
 * Baseline exclusions that the M1 substrate ALWAYS applies, regardless
 * of policy. `.git` and `.jj` carry trust-sensitive metadata (hooks,
 * config, refs, object storage) that the agent must never see or
 * mutate. `node_modules` is excluded by default because copying it
 * adds substantial latency and the agent can rerun `bun install` /
 * `npm install` inside the replica if needed.
 *
 * Operators can extend (but not narrow) this list via
 * `policy.excludePaths`.
 */
const BASELINE_EXCLUDE_PREFIXES: readonly string[] = [".git", ".jj", "node_modules"];

/**
 * Internal per-workspace baseline snapshot — content hashes keyed by
 * path. Used by `inspectReplica` to diff replica state against
 * create-time state. In-memory; lost across process restarts. Per-task
 * ephemeral replicas (the v1 lifecycle pattern) make this acceptable.
 */
interface BaselineSnapshot {
  /** Map of relative path → content sha256 hex. */
  hashes: ReadonlyMap<string, string>;
  policy: WorkspacePolicy;
}

/** Options for {@link createCopiedReplicaBackend}. */
export interface CopiedReplicaBackendOptions {
  /**
   * Root directory under which per-workspace replicas live. Each
   * `createReplica` call creates a subdir `<root>/<workspaceId>/`.
   * Defaults to `<os.tmpdir>/agents-js-replicas/`.
   */
  replicaRoot?: string;
  /**
   * Clock injection for tests (so `createdAt` and workspaceId
   * randomness can be deterministic).
   */
  now?: () => Date;
  /**
   * Deterministic workspaceId generator for tests. Defaults to a
   * crypto-random uuid-shaped id.
   */
  generateWorkspaceId?: () => string;
}

/**
 * Build a `CopiedReplicaBackend`. Replicas are stored under
 * `replicaRoot/<workspaceId>/`; the source's `.git`, `.jj`, and
 * `node_modules` are excluded at copy-time. Symlinks present in the
 * source are FOLLOWED (resolved to their target's content) so an
 * agent operating in the replica never sees a symlink pointing
 * outside its sandbox.
 */
export function createCopiedReplicaBackend(
  options: CopiedReplicaBackendOptions = {},
): WorkspaceIsolationProvider {
  const replicaRoot = options.replicaRoot ?? join(tmpdir(), "agents-js-replicas");
  const now = options.now ?? (() => new Date());
  const generateWorkspaceId = options.generateWorkspaceId ?? (() => crypto.randomUUID());

  // Per-instance state: handles + baselines. Lives only as long as the
  // backend instance. Operators wanting persistence across restarts
  // should write their own provider on top of durable storage.
  const handles = new Map<string, IsolatedWorkspace>();
  const baselines = new Map<string, BaselineSnapshot>();

  return {
    name: "copied-replica",

    async createReplica(input: CreateReplicaInput): Promise<IsolatedWorkspace> {
      const sourceStat = await stat(input.repoPath).catch(() => null);
      if (!sourceStat?.isDirectory()) {
        throw new Error(`[workspace-isolation] source path is not a directory: ${input.repoPath}`);
      }
      // Canonicalize via realpath so symlink-escape checks survive
      // host-side symlink chains (e.g. macOS `/tmp` → `/private/tmp`).
      // Without this, every intra-source relative symlink false-flags
      // on macOS because the resolved target starts with `/private/...`
      // while `sourceAbs` started with `/tmp/...`.
      const sourceAbs = await realpath(input.repoPath);

      const workspaceId = generateWorkspaceId();
      // mkdir replicaRoot before canonicalization so realpath
      // resolves the symlink chain (e.g. macOS `/tmp` → `/private/tmp`)
      // on a path that exists. Without the mkdir-first, realpath
      // would throw ENOENT on the first replica per backend instance.
      await mkdir(replicaRoot, { recursive: true });
      const canonicalReplicaRoot = await realpath(replicaRoot);
      const replicaAbs = join(canonicalReplicaRoot, workspaceId);
      // Replica MUST be outside the source repo. If `replicaRoot` is
      // ever misconfigured to live inside `sourceAbs`, abort before
      // copying — refuse to operate rather than risk recursive copy
      // or in-tree replica pollution.
      if (replicaAbs.startsWith(`${sourceAbs}${sep}`) || replicaAbs === sourceAbs) {
        throw new Error(
          `[workspace-isolation] replica path ${replicaAbs} cannot live inside source ${sourceAbs}`,
        );
      }
      const replicaPath = replicaAbs;
      await mkdir(replicaPath, { recursive: true });

      const excludes: readonly string[] = [
        ...BASELINE_EXCLUDE_PREFIXES,
        ...(input.policy.excludePaths ?? []),
      ];

      // Pre-validate source for symlinks escaping the source tree. We
      // do this BEFORE the copy so we can fail atomically (no leftover
      // partial replica). `fs.cp` would follow such links into
      // arbitrary host paths.
      await assertNoEscapingSymlinks(sourceAbs, sourceAbs, excludes).catch(async (err) => {
        await rm(replicaPath, { recursive: true, force: true });
        throw err;
      });

      try {
        await cp(sourceAbs, replicaPath, {
          recursive: true,
          // Follow symlinks rather than preserving them. We've already
          // verified above that no source symlink escapes the source
          // tree, so following is safe — the agent gets copies of the
          // resolved content and cannot use a symlink to reach
          // arbitrary host paths through the replica.
          dereference: true,
          filter: (src: string): boolean => {
            const rel = relative(sourceAbs, src);
            if (rel === "" || rel === ".") return true;
            return !isPathExcluded(rel, excludes);
          },
        });
      } catch (err) {
        await rm(replicaPath, { recursive: true, force: true });
        throw err;
      }

      const hashes = await hashTree(replicaPath, replicaPath);

      const handle: IsolatedWorkspace = {
        workspaceId,
        replicaPath: replicaAbs,
        baseRef: input.baseRef,
        agentId: input.agentId,
        taskId: input.taskId,
        createdAt: now().toISOString(),
      };
      handles.set(workspaceId, handle);
      baselines.set(workspaceId, { hashes, policy: input.policy });
      return handle;
    },

    async inspectReplica(input): Promise<ReplicaInspectionResult> {
      const handle = handles.get(input.workspaceId);
      const baseline = baselines.get(input.workspaceId);
      if (!handle || !baseline) {
        throw new Error(`[workspace-isolation] unknown workspaceId: ${input.workspaceId}`);
      }

      // Canonicalize the replica root via realpath so symlink-escape
      // detection survives host-side symlink chains (notably macOS's
      // `/tmp` → `/private/tmp`). Without this, every intra-replica
      // symlink false-flags as an escape on macOS.
      const canonicalRoot = await realpath(handle.replicaPath);
      const current = await hashTree(canonicalRoot, canonicalRoot);
      const symlinks = await walkSymlinks(canonicalRoot, canonicalRoot);

      const changedPaths: string[] = [];
      const addedPaths: string[] = [];
      for (const [path, hash] of current) {
        const baseHash = baseline.hashes.get(path);
        if (baseHash === undefined) {
          addedPaths.push(path);
        } else if (baseHash !== hash) {
          changedPaths.push(path);
        }
      }
      const deletedPaths: string[] = [];
      for (const path of baseline.hashes.keys()) {
        if (!current.has(path)) deletedPaths.push(path);
      }

      const protectedPathMutations = collectProtectedMutations(
        [...changedPaths, ...addedPaths, ...deletedPaths],
        baseline.policy.protectedPaths ?? [],
      );

      return {
        changedPaths: Object.freeze(changedPaths.sort()),
        addedPaths: Object.freeze(addedPaths.sort()),
        deletedPaths: Object.freeze(deletedPaths.sort()),
        symlinks: Object.freeze(symlinks),
        protectedPathMutations: Object.freeze(protectedPathMutations.sort()),
      };
    },

    async exportChangeSet(input): Promise<ChangeSet> {
      const handle = handles.get(input.workspaceId);
      const baseline = baselines.get(input.workspaceId);
      if (!handle || !baseline) {
        throw new Error(`[workspace-isolation] unknown workspaceId: ${input.workspaceId}`);
      }

      const inspection = await this.inspectReplica({ workspaceId: input.workspaceId });
      const allPaths = [
        ...inspection.changedPaths,
        ...inspection.addedPaths,
        ...inspection.deletedPaths,
      ].sort();

      if (input.format === "rsync-manifest") {
        return {
          format: "rsync-manifest",
          content: allPaths.join("\n"),
          paths: Object.freeze(allPaths),
        };
      }

      // Human-readable summary — diff-SHAPED but NOT git-applyable.
      // We don't retain baseline bytes (just hashes), so we can't
      // emit real unified-diff hunks. The summary is sufficient for
      // reviewer-facing display: each path tagged with its change
      // kind (modified / added / deleted) and (where it's a regular
      // utf8 file in the replica) the current content inline.
      //
      // The leading `WORKSPACE-CHANGE-SUMMARY (NOT-APPLYABLE)` banner
      // is intentional — a future caller who pipes this into
      // `git apply` should fail loudly at parse time rather than
      // silently produce nonsense. Real-patch generation is a v1.1
      // follow-up; for now, callers who need an applyable diff
      // should walk the replica path directly + diff against source
      // HEAD with `git diff --no-index` or `diff -u`.
      const sections: string[] = [];
      sections.push("WORKSPACE-CHANGE-SUMMARY (NOT-APPLYABLE)");
      for (const path of inspection.changedPaths) {
        sections.push("");
        sections.push(`# modified: ${path}`);
        const current = await safeReadUtf8(join(handle.replicaPath, path));
        for (const line of current.split("\n")) {
          sections.push(`  ${line}`);
        }
      }
      for (const path of inspection.addedPaths) {
        sections.push("");
        sections.push(`# added: ${path}`);
        const current = await safeReadUtf8(join(handle.replicaPath, path));
        for (const line of current.split("\n")) {
          sections.push(`  ${line}`);
        }
      }
      for (const path of inspection.deletedPaths) {
        sections.push("");
        sections.push(`# deleted: ${path}`);
      }

      return {
        format: "summary",
        content: sections.join("\n"),
        paths: Object.freeze(allPaths),
      };
    },

    async destroy(workspaceId: string): Promise<void> {
      const handle = handles.get(workspaceId);
      if (!handle) {
        // Idempotent: destroying an unknown / already-destroyed
        // workspace is a no-op. Consumers cleaning up on error paths
        // shouldn't have to worry about double-destroy throwing.
        return;
      }
      await rm(handle.replicaPath, { recursive: true, force: true });
      handles.delete(workspaceId);
      baselines.delete(workspaceId);
    },
  };
}

/**
 * Check whether a path (relative to source root) matches any of the
 * exclusion patterns. Three match modes:
 *
 *  1. **Single-segment patterns** (no path separator) match a directory
 *     or file with that name ANYWHERE in the tree. `"node_modules"`
 *     matches both `node_modules/` at the root and
 *     `packages/foo/node_modules/foo.js`. Mirrors typical `.gitignore`
 *     basename semantics.
 *  2. **Multi-segment patterns** (containing `/` or platform `sep`)
 *     match as path PREFIXES relative to the source root.
 *     `"src/generated"` matches `src/generated`,
 *     `src/generated/file.ts`, and any deeper nested entry. Pinned by
 *     @cognee-codex review id 18: the previous behavior failed to
 *     descend into multi-segment prefix matches and leaked
 *     `src/generated/file.ts` into the replica.
 *  3. **Exact match** is implied by both branches above.
 *
 * Path separators are normalized to forward-slash for comparison so
 * Windows-style backslash patterns also work (defensive — we don't
 * support Windows officially in v1, but normalization is the safer
 * default).
 */
function isPathExcluded(relPath: string, excludes: readonly string[]): boolean {
  const normPath = relPath.split(sep).join("/");
  const segments = normPath.split("/");
  for (const exRaw of excludes) {
    const ex = exRaw.split(sep).join("/").replace(/\/+$/, "");
    if (ex === "") continue;
    if (ex.includes("/")) {
      // Multi-segment pattern → prefix match (path equals OR starts
      // with `ex/`). Pinned by tests `caller-supplied excludePaths
      // additively excluded from replica` + the multi-segment case
      // below.
      if (normPath === ex) return true;
      if (normPath.startsWith(`${ex}/`)) return true;
    } else {
      // Single-segment pattern → name-anywhere match. Defensive on
      // single-segment patterns that happen to nest (e.g. `.git`
      // inside a submodule), preserving the established
      // `node_modules`-anywhere semantics.
      if (segments.includes(ex)) return true;
    }
  }
  return false;
}

/**
 * Recursively walk the source tree; if any symlink resolves to a
 * path OUTSIDE the source root, throw. Excluded paths are skipped
 * (so a symlink inside `node_modules` doesn't block a copy that's
 * going to drop `node_modules` anyway).
 */
async function assertNoEscapingSymlinks(
  root: string,
  cursor: string,
  excludes: readonly string[],
): Promise<void> {
  const entries = await readdir(cursor, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(cursor, entry.name);
    const rel = relative(root, full);
    if (isPathExcluded(rel, excludes)) continue;
    if (entry.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = await realpath(full);
      } catch {
        // Broken symlink — treat as a soft escape (it COULD be made
        // to point anywhere). Refuse rather than guessing intent.
        throw new Error(
          `[workspace-isolation] source symlink ${rel} is broken or unreadable; refusing to replicate`,
        );
      }
      const target = resolve(resolved);
      if (!target.startsWith(`${root}${sep}`) && target !== root) {
        throw new Error(
          `[workspace-isolation] source symlink ${rel} escapes the source tree (target: ${target})`,
        );
      }
    }
    if (entry.isDirectory()) {
      await assertNoEscapingSymlinks(root, full, excludes);
    }
  }
}

/**
 * Build a content-hash snapshot of every regular file under `root`,
 * keyed by path relative to `root`. Symlinks and directories are
 * skipped (symlinks are handled separately by walkSymlinks).
 */
async function hashTree(root: string, cursor: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await readdir(cursor, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(cursor, entry.name);
    const rel = relative(root, full);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      const nested = await hashTree(root, full);
      for (const [k, v] of nested) out.set(k, v);
      continue;
    }
    if (entry.isFile()) {
      const bytes = await readFile(full);
      const hash = createHash("sha256").update(bytes).digest("hex");
      out.set(rel, hash);
    }
  }
  return out;
}

/**
 * Walk the replica and report every symlink found, with its target
 * and whether it escapes the replica root. Used by `inspectReplica`
 * to surface symlink-injection attempts the agent may have made
 * after `createReplica`.
 *
 * `root` should be the realpath of the replica root (passed in by
 * the caller) so that comparisons survive macOS's `/tmp` →
 * `/private/tmp` symlink and any other host-side symlink chain to
 * the replica root itself. Without that canonicalization, every
 * intra-replica symlink would false-flag as an escape on macOS
 * because the canonical resolved path starts with `/private/...`
 * while the configured root started with `/tmp/...`.
 */
async function walkSymlinks(
  root: string,
  cursor: string,
): Promise<Array<{ path: string; target: string; escapes: boolean }>> {
  const out: Array<{ path: string; target: string; escapes: boolean }> = [];
  const entries = await readdir(cursor, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(cursor, entry.name);
    const rel = relative(root, full);
    if (entry.isSymbolicLink()) {
      const target = await readlink(full).catch(() => "");
      let resolved: string;
      try {
        resolved = await realpath(full);
      } catch {
        // Broken symlink — classify as escape (denylist by default).
        out.push({ path: rel, target, escapes: true });
        continue;
      }
      const absResolved = resolve(resolved);
      const escapes = !(absResolved.startsWith(`${root}${sep}`) || absResolved === root);
      out.push({ path: rel, target, escapes });
      continue;
    }
    if (entry.isDirectory()) {
      const nested = await walkSymlinks(root, full);
      out.push(...nested);
    }
  }
  return out;
}

function collectProtectedMutations(
  paths: readonly string[],
  protectedPaths: readonly string[],
): string[] {
  if (protectedPaths.length === 0) return [];
  const out: string[] = [];
  for (const path of paths) {
    for (const pat of protectedPaths) {
      if (path === pat || path.startsWith(`${pat}${sep}`) || path.startsWith(`${pat}/`)) {
        out.push(path);
        break;
      }
    }
  }
  return out;
}

async function safeReadUtf8(path: string): Promise<string> {
  try {
    const bytes = await readFile(path);
    return bytes.toString("utf8");
  } catch {
    return "";
  }
}

// `mkdtemp`/`lstat` are imported above for future use (broken-symlink
// classification in v1.1 + secure-temp lifecycle in DockerBackend);
// silence the unused-import lint without removing them.
void mkdtemp;
void lstat;
