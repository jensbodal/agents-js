import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repoRoot } from "./workspace-config.ts";

/**
 * Default lock path used by the real smoke runner. Tests pass their
 * own `lockPath` via {@link WithExternalConsumerSmokeLockOptions} to
 * keep test state out of the repo's `.tmp/` and to allow concurrent
 * test files without trampling each other.
 */
const DEFAULT_LOCK_PATH = path.join(repoRoot, ".tmp", "external-consumer-smoke.lock");
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 100;

/**
 * Maximum time we'll trust a lock holder to still be working before
 * reclaiming the lock as stale. The smoke runs typically complete in
 * 30–90s on a quiet runner; we set the staleness threshold at 5 min
 * so even pathologically slow runs aren't preempted prematurely, but
 * a crashed/killed holder doesn't block the next CI run for 2 minutes
 * (which was AJS-53's observable failure pattern — see commit message).
 */
const STALE_LOCK_AGE_MS = 5 * 60 * 1000;

/**
 * Grace window for in-progress initialization. A lock dir created
 * less than `LOCK_INIT_GRACE_MS` ago is treated as "still being
 * initialized" — its missing/malformed `holder.json` doesn't
 * classify the lock as stale yet.
 *
 * Pinned by @cognee-codex review on PR #51 (issuecomment-1352).
 * Without this grace, a second process can race the first holder's
 * `writeHolder` between `mkdir(lockPath)` and `writeFile(holder.json)`,
 * see missing metadata, reclaim the lock, and run its callback
 * concurrently with the first holder — breaking the whole
 * serialization invariant. The grace period closes that race window
 * because `writeHolder` completes in milliseconds while the grace
 * is 2 seconds.
 *
 * Same-host dead-PID and age-over-5min reclaim still apply
 * UNCONDITIONALLY — those are unambiguous signals where the grace
 * is irrelevant.
 */
const LOCK_INIT_GRACE_MS = 2_000;

interface LockHolder {
  pid: number;
  hostname: string;
  acquiredAt: number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/**
 * Returns `true` when the given process exists on this host. Uses
 * `process.kill(pid, 0)` which doesn't actually deliver a signal but
 * triggers the kernel's permission/existence check. `ESRCH` means
 * "no such process"; `EPERM` means the process exists but we can't
 * signal it (still alive); any other error is treated as "alive"
 * defensively (don't reclaim a lock unless we're sure the holder
 * is dead).
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === "ESRCH") return false;
    return true;
  }
}

/**
 * Read the lock-holder metadata. Returns `null` when the file doesn't
 * exist, is unreadable, or is malformed — any of which is sufficient
 * grounds to consider the lock stale (a well-behaved holder always
 * writes its `holder.json` before doing real work).
 */
async function readHolder(lockDirPath: string): Promise<LockHolder | null> {
  const holderPath = path.join(lockDirPath, "holder.json");
  let raw: string;
  try {
    raw = await readFile(holderPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.acquiredAt === "number"
    ) {
      return parsed as LockHolder;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the lock dir's own creation/modification time, in epoch ms.
 * Used for the young-lock grace check — a lock dir created seconds
 * ago is considered "still being initialized" and protected from
 * race-reclaim even when its `holder.json` is missing or malformed.
 *
 * Returns `Infinity` (treat as "infinitely old") on stat failure
 * so the grace window doesn't accidentally protect a lock dir that
 * doesn't actually exist or whose mtime we can't read.
 *
 * Note on the platform mtime/birthtime split: `birthtimeMs` is not
 * universally reliable (some filesystems don't track it; Linux
 * historically reports it as 0). We use `mtimeMs` because every
 * POSIX-ish filesystem updates it on directory creation, and a lock
 * dir is short-lived enough that mtime accurately approximates
 * birthtime. The age comparison is intentionally generous (2s grace
 * vs ~10ms expected init time), so even minor mtime jitter is
 * absorbed.
 */
async function getLockDirAgeMs(lockDirPath: string, now: number): Promise<number> {
  try {
    const st = await lstat(lockDirPath);
    return Math.max(0, now - st.mtimeMs);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Decide whether the existing lock should be reclaimed.
 *
 * **Always-stale** (no grace window, evaluated first):
 *   - `acquiredAt` older than {@link STALE_LOCK_AGE_MS} — defensive
 *     max-age catch-all for crashed holders on unreachable hosts.
 *   - Holder is on the same host AND its PID is no longer alive
 *     (`process.kill(pid, 0)` → ESRCH).
 *
 * **Stale only after init grace expires:**
 *   - `holder.json` missing or malformed → stale ONLY when the lock
 *     dir's mtime is older than {@link LOCK_INIT_GRACE_MS} ago. Under
 *     the grace window the holder is assumed to be mid-init (between
 *     `mkdir(lockPath)` and `writeFile(holder.json)`), and a peer that
 *     reclaimed during that window would break the serialization
 *     invariant. Pinned by @cognee-codex review on PR #51 race-
 *     condition catch.
 *
 * Cross-host PID dead detection is impossible from this host, so for
 * different-host holders we rely on the age threshold alone.
 *
 * Exported for testing — implementations of the staleness rule
 * should be inspectable independently of the acquire loop.
 */
export async function isLockStale(
  lockDirPath: string,
  now: number,
  isAliveFn: (pid: number) => boolean = isProcessAlive,
  hostnameFn: () => string = hostname,
  graceMs: number = LOCK_INIT_GRACE_MS,
): Promise<boolean> {
  const holder = await readHolder(lockDirPath);
  if (holder !== null) {
    // Holder metadata present + parseable — unambiguous signals only.
    if (now - holder.acquiredAt > STALE_LOCK_AGE_MS) return true;
    if (holder.hostname === hostnameFn() && !isAliveFn(holder.pid)) return true;
    return false;
  }
  // Holder metadata missing or malformed. Trust the holder to still
  // be writing it ONLY within the init grace window. After grace
  // expires, the lock dir is truly orphaned (mkdir never paired with
  // a valid writeHolder) and must be reclaimed.
  //
  // Comparison is `>=` so that `graceMs: 0` (test override) classifies
  // any non-negative age as stale, even when the test executes the
  // staleness check on a just-created lock dir whose mtimeMs equals
  // `now()` due to fast-machine clock resolution.
  const dirAge = await getLockDirAgeMs(lockDirPath, now);
  return dirAge >= graceMs;
}

/**
 * Write the lock-holder metadata inside the just-created lock dir.
 * Fails closed: a write failure means we cannot prove our liveness to
 * peers (they'd see missing `holder.json` and — after the grace
 * window — reclaim the lock from under us). Better to surface the
 * I/O error to the caller, which releases the lock dir in its
 * `finally`, than to silently hold a lock peers will eventually
 * reclaim while we're mid-callback.
 *
 * Pinned by @cognee-codex review on PR #51: "metadata write path
 * also swallows failures, so the first holder can proceed without
 * valid lock metadata. That breaks the serialization invariant."
 */
async function writeHolder(lockDirPath: string): Promise<void> {
  const holderPath = path.join(lockDirPath, "holder.json");
  const payload: LockHolder = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: Date.now(),
  };
  await writeFile(holderPath, `${JSON.stringify(payload, null, 2)}\n`);
}

/** Options for {@link withExternalConsumerSmokeLock}. */
export interface WithExternalConsumerSmokeLockOptions {
  /** Override the lock dir path (used by tests). */
  lockPath?: string;
  /** Max wait time before throwing. Defaults to 120_000ms. */
  timeoutMs?: number;
  /** Poll interval. Defaults to 100ms. */
  pollIntervalMs?: number;
}

/**
 * Acquire the external-consumer-smoke serialization lock, run
 * `callback`, then release. Implemented as an EEXIST-fenced
 * `mkdir(lockDir)` plus a `holder.json` inside the dir for staleness
 * detection.
 *
 * Behavior matrix:
 *   - Lock free → acquire, write holder.json, run callback, release.
 *   - Lock held by live process → poll every {@link POLL_INTERVAL_MS}
 *     until released or `timeoutMs` elapses.
 *   - Lock held by dead PID on same host → reclaim immediately.
 *   - Lock older than {@link STALE_LOCK_AGE_MS} → reclaim immediately.
 *   - Lock dir exists without a holder.json → reclaim immediately
 *     (partial init or unrelated stale state).
 *
 * Stale detection was added 2026-05-22 to fix AJS-53: when a test
 * holding the lock hit its 60s test-timeout, the `finally` cleanup
 * didn't run, the lock dir stayed on disk, and the next test waited
 * the full 120s timeout before failing — converting one slow test
 * into a 180+s cascading failure across the whole `deterministic`
 * job. Same-host PID liveness + 5-min age fallback ensures crashed
 * holders self-clean on the next acquire attempt.
 */
export async function withExternalConsumerSmokeLock<T>(
  callback: () => Promise<T>,
  optionsOrTimeoutMs: WithExternalConsumerSmokeLockOptions | number = {},
): Promise<T> {
  // Back-compat: existing callers pass a bare `timeoutMs` number.
  const options: WithExternalConsumerSmokeLockOptions =
    typeof optionsOrTimeoutMs === "number" ? { timeoutMs: optionsOrTimeoutMs } : optionsOrTimeoutMs;
  const lockPath = options.lockPath ?? DEFAULT_LOCK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

  await mkdir(path.dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      if (await isLockStale(lockPath, Date.now())) {
        // Stale lock detected — best-effort reclaim. If multiple
        // processes race to reclaim, the first `rm` + next `mkdir`
        // wins; the loser retries through this same path on the next
        // iteration.
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for external consumer smoke lock: ${lockPath}`);
      }

      await delay(pollIntervalMs);
    }
  }

  // `writeHolder` + `callback` wrapped in the SAME try/finally so a
  // metadata write failure releases the just-acquired lock dir. Prior
  // shape (write before try, callback inside try) leaked the lock dir
  // on writeHolder failure — pinned by @cognee-codex review on PR #51.
  try {
    await writeHolder(lockPath);
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
