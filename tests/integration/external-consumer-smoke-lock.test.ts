/**
 * AJS-53 — `external-consumer-smoke-lock.ts` stale-lock detection.
 *
 * Root cause (banked from cognee-claude's AJS-53 active investigation
 * dispatch, matrix event `$elErQP4DeVA1sSGVWpcC-uqu-uaDmWjL-Tx4cN3cOwI`):
 * the previous lock implementation had no staleness detection. When a
 * smoke test holding the lock hit its 60s test-timeout, bun:test
 * killed the test promise — the `finally` cleanup did NOT run, the
 * lock dir stayed on disk, and the next test waited the full 120s
 * timeout before failing. Same flake hit PRs #40, #46, #50 (twice in
 * one cycle on the last).
 *
 * Fix: `holder.json` inside the lock dir carries `{pid, hostname,
 * acquiredAt}`. On EEXIST, we read it. Lock is reclaimed if any of:
 *   - `holder.json` missing or malformed (partial init / unrelated stale)
 *   - `acquiredAt` older than 5 minutes (defensive max-age fallback)
 *   - same-host AND PID is no longer alive (`process.kill(pid, 0)`
 *     returns ESRCH)
 *
 * These tests pin those reclaim paths against a per-test scratch
 * lock dir so they don't trample the real smoke runner's lock or
 * each other.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import {
  isLockStale,
  withExternalConsumerSmokeLock,
} from "../../scripts/external-consumer-smoke-lock.ts";

let scratchRoot: string;
let lockPath: string;

beforeEach(async () => {
  scratchRoot = path.join(tmpdir(), `ajs-53-lock-test-${crypto.randomUUID()}`);
  lockPath = path.join(scratchRoot, "smoke.lock");
  await mkdir(scratchRoot, { recursive: true });
});

afterEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
});

async function writeHolderFile(opts: {
  pid?: number;
  hostname?: string;
  acquiredAt?: number;
  malformed?: boolean;
  missing?: boolean;
}): Promise<void> {
  await mkdir(lockPath, { recursive: true });
  if (opts.missing) return;
  const holderPath = path.join(lockPath, "holder.json");
  if (opts.malformed) {
    await writeFile(holderPath, "this is not valid JSON {");
    return;
  }
  await writeFile(
    holderPath,
    JSON.stringify({
      pid: opts.pid ?? process.pid,
      hostname: opts.hostname ?? hostname(),
      acquiredAt: opts.acquiredAt ?? Date.now(),
    }),
  );
}

describe("tests/integration/external-consumer-smoke-lock.test.ts — AJS-53 stale-lock detection", () => {
  /**
   * WHAT: A FRESH lock dir (created just now) with missing
   *       `holder.json` is NOT stale — the holder is presumed to be
   *       mid-init (between `mkdir(lockPath)` and `writeFile(holder.json)`).
   * WHY: Pinned by @cognee-codex's race-condition catch on PR #51
   *      review (issuecomment-1352). Without the young-lock grace
   *      window, a second process can reclaim during the
   *      milliseconds-wide gap between the first process's `mkdir`
   *      and `writeHolder`, then run its callback concurrently with
   *      the first holder — breaking serialization. The grace
   *      window closes that race because writeHolder finishes in
   *      milliseconds while the grace is 2 seconds. Pin this
   *      explicitly with `graceMs: 2_000` so a future change can't
   *      silently shorten the grace below the writeHolder time.
   */
  test("FRESH missing holder.json + grace → NOT stale (race-window protection)", async () => {
    await writeHolderFile({ missing: true });
    // graceMs=2000 with a just-created lock dir → under-grace → not stale.
    expect(
      await isLockStale(
        lockPath,
        Date.now(),
        () => true,
        () => "this-host",
        2_000,
      ),
    ).toBe(false);
  });

  /**
   * WHAT: An OLD lock dir (older than the grace window) with missing
   *       `holder.json` IS stale.
   * WHY: The grace window protects fresh in-progress init; once the
   *      window expires, missing metadata means the holder crashed
   *      mid-init and the lock is truly orphaned. Reclaim restores
   *      the AJS-53 fix. Pin this with `graceMs: 0` so the lock-dir
   *      mtime is necessarily older than the grace regardless of
   *      filesystem timestamp resolution.
   */
  test("OLD missing holder.json (past grace) → stale", async () => {
    await writeHolderFile({ missing: true });
    // graceMs=0 → any non-zero age qualifies as stale.
    expect(
      await isLockStale(
        lockPath,
        Date.now(),
        () => true,
        () => "this-host",
        0,
      ),
    ).toBe(true);
  });

  /**
   * WHAT: A FRESH lock dir with malformed `holder.json` is NOT stale
   *       under the grace window.
   * WHY: Same race-window protection as the missing case — a partial
   *      write (truncated holder.json mid-flight) inside the grace
   *      window should NOT trigger reclaim. Pinned with the same
   *      grace value as the missing case so a regression treating
   *      malformed differently than missing fails this test.
   */
  test("FRESH malformed holder.json + grace → NOT stale", async () => {
    await writeHolderFile({ malformed: true });
    expect(
      await isLockStale(
        lockPath,
        Date.now(),
        () => true,
        () => "this-host",
        2_000,
      ),
    ).toBe(false);
  });

  /**
   * WHAT: An OLD lock dir with malformed `holder.json` (past grace)
   *       IS stale.
   * WHY: Mirror of the OLD-missing case. After grace expires, malformed
   *      metadata is undecidable evidence of liveness, so reclaim.
   */
  test("OLD malformed holder.json (past grace) → stale", async () => {
    await writeHolderFile({ malformed: true });
    expect(
      await isLockStale(
        lockPath,
        Date.now(),
        () => true,
        () => "this-host",
        0,
      ),
    ).toBe(true);
  });

  /**
   * WHAT: `isLockStale` returns `true` when `acquiredAt` is older than
   *       5 minutes, regardless of host or PID liveness.
   * WHY: Cross-host PID-liveness is impossible to verify from this
   *      host (PID 12345 on a different machine is meaningless to us).
   *      The age threshold is the catch-all: no legitimate smoke run
   *      takes 5 minutes; any lock older than that is detritus from
   *      a crashed holder on an unreachable / different machine.
   */
  test("acquiredAt older than 5 minutes → stale (regardless of liveness)", async () => {
    const now = Date.now();
    await writeHolderFile({
      acquiredAt: now - 6 * 60 * 1000,
      hostname: "other-host",
      pid: 1, // PID 1 is always alive (init); test the age path overrides
    });
    // Force isAliveFn=true so the test stresses ONLY the age path.
    expect(
      await isLockStale(
        lockPath,
        now,
        () => true,
        () => "this-host",
      ),
    ).toBe(true);
  });

  /**
   * WHAT: `isLockStale` returns `true` when the holder's host matches
   *       this host AND the holder's PID is no longer alive.
   * WHY: The AJS-53 primary failure mode. Test killed mid-`bun install`,
   *      lock leaks. The same-host + dead-PID combo is unambiguous
   *      evidence that the holder is gone; reclaim immediately rather
   *      than wait 120s.
   */
  test("same-host + dead PID → stale", async () => {
    await writeHolderFile({ pid: 999999, hostname: "host-A" }); // PID 999999 is essentially never alive
    expect(
      await isLockStale(
        lockPath,
        Date.now(),
        () => false, // simulate "PID is dead"
        () => "host-A",
      ),
    ).toBe(true);
  });

  /**
   * WHAT: `isLockStale` returns `false` when the holder is on a
   *       DIFFERENT host (regardless of whether our local PID lookup
   *       would say "alive" or "dead"). Combined with the age check,
   *       cross-host holders are only reclaimed via the age threshold.
   * WHY: Defense-in-depth. PID liveness across hosts is meaningless
   *      (PID 12345 on host-B has no relationship to PID 12345 on
   *      host-A). A false-reclaim here would let two CI runs on
   *      different runners stomp each other's tarball-pack output —
   *      worse than the original AJS-53 symptom.
   */
  test("cross-host + dead PID → NOT stale (age-only path)", async () => {
    await writeHolderFile({
      pid: 999999,
      hostname: "host-A",
      acquiredAt: Date.now() - 10_000, // recent
    });
    expect(
      await isLockStale(
        lockPath,
        Date.now(),
        () => false,
        () => "host-B", // we're on B; holder is on A
      ),
    ).toBe(false);
  });

  /**
   * WHAT: `isLockStale` returns `false` when the holder is same-host
   *       AND the PID is alive AND the age is recent. The "live
   *       holder doing real work" case must NOT false-reclaim.
   * WHY: Counterpart to the dead-PID test. Without this, a regression
   *      that always-reclaims would pass every other test (they all
   *      check stale=true). Negative pin guards against the "deny
   *      everything" anti-fix.
   */
  test("same-host + alive PID + recent → NOT stale", async () => {
    await writeHolderFile({ pid: process.pid, hostname: hostname() });
    expect(
      await isLockStale(
        lockPath,
        Date.now(),
        () => true,
        () => hostname(),
      ),
    ).toBe(false);
  });

  /**
   * WHAT: `withExternalConsumerSmokeLock` runs the callback when no
   *       lock pre-exists, writes `holder.json` for the duration, and
   *       cleans up the lock dir on success.
   * WHY: Positive path. Without this, the stale-detection paths could
   *      all pass while normal acquire/release is broken — a "deny
   *      everything" regression.
   */
  test("happy path: acquires + runs callback + releases lock", async () => {
    let holderObservedInCallback: { pid: number } | null = null;
    const result = await withExternalConsumerSmokeLock(
      async () => {
        // Inside the callback, the holder.json MUST exist with our PID.
        const raw = await readFile(path.join(lockPath, "holder.json"), "utf8");
        holderObservedInCallback = JSON.parse(raw);
        return "callback-return-value";
      },
      { lockPath },
    );
    expect(result).toBe("callback-return-value");
    expect(holderObservedInCallback).not.toBeNull();
    expect(holderObservedInCallback?.pid).toBe(process.pid);
    // Lock dir cleaned up after release.
    await expect(access(lockPath)).rejects.toThrow();
  });

  /**
   * WHAT: When the callback throws, the lock dir is STILL cleaned up.
   * WHY: The whole point of the lock is to be re-acquirable. A regression
   *      that skipped cleanup on error would re-introduce the exact
   *      AJS-53 failure mode (lock leaks, next acquire waits 120s).
   *      The `finally` clause carries the contract; pin it explicitly.
   */
  test("callback throws → lock still released", async () => {
    await expect(
      withExternalConsumerSmokeLock(
        async () => {
          throw new Error("callback failure");
        },
        { lockPath },
      ),
    ).rejects.toThrow("callback failure");
    await expect(access(lockPath)).rejects.toThrow();
  });

  /**
   * WHAT: When a stale lock exists at acquire-time, the lock is
   *       reclaimed and the callback runs. End-to-end integration of
   *       `isLockStale` + the acquire loop.
   * WHY: The `isLockStale` unit tests prove the staleness rule; this
   *      test proves the LOCK USES IT. A regression that computed
   *      staleness but never acted on it would pass the unit tests
   *      and still produce the AJS-53 failure shape. This is the
   *      one-test-that-catches-the-real-bug pin.
   */
  test("stale lock is reclaimed at acquire-time; callback runs", async () => {
    // Create an UNAMBIGUOUSLY stale lock: well-formed holder.json
    // with `acquiredAt` older than the 5-min stale-age threshold.
    // This path is grace-window-independent — even a freshly-mtime'd
    // lock dir is reclaimed when its `acquiredAt` is ancient.
    // Malformed holder + fresh mtime would NOT reclaim under the new
    // grace logic (pinned by the FRESH malformed test above), so we
    // use the always-stale age path here.
    await writeHolderFile({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: Date.now() - 6 * 60 * 1000, // past STALE_LOCK_AGE_MS
    });
    const result = await withExternalConsumerSmokeLock(async () => "reclaimed", {
      lockPath,
      timeoutMs: 5_000,
    });
    expect(result).toBe("reclaimed");
  });

  /**
   * WHAT: When a NON-stale lock exists and the acquire times out, the
   *       lock is NOT reclaimed and a "Timed out" error is thrown.
   * WHY: The reclaim path must NOT fire for live holders. Pinned with
   *      a short `timeoutMs` (50ms) + a fresh-looking holder.json so
   *      isLockStale → false. If this test starts passing while the
   *      reclaim path is misfiring, we've broken the live-holder
   *      coexistence invariant.
   */
  test("live (non-stale) lock + timeout → throws 'Timed out'", async () => {
    await writeHolderFile({ pid: process.pid, hostname: hostname() });
    await expect(
      withExternalConsumerSmokeLock(async () => "should-not-run", {
        lockPath,
        timeoutMs: 50,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/Timed out waiting for external consumer smoke lock/);
    // Lock NOT cleaned up — the live holder is still nominally there.
    // (In real life their `finally` releases it; we just pinned that we
    // don't preempt them.) `access` resolves with `null` on bun when
    // the path exists; the absence of a thrown error is what we care
    // about.
    await expect(access(lockPath)).resolves.toBeNull();
  });
});
