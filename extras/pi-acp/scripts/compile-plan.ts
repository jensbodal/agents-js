/**
 * Pure (import-safe, side-effect-free) resolver for the pi-acp
 * `bun build --compile` plan. Kept out of `build-bin.ts` so it can be unit
 * tested without triggering the actual compile that the build script runs at
 * module top level.
 *
 * Why this exists: `bun build --compile` produces a binary for the host
 * architecture unless an explicit `--target` is passed. A macOS arm64 build
 * copied to a Linux runtime host fails with `ENOEXEC` (the 2026-06-08 gateway
 * outage). This resolver makes the compile target selectable while keeping the
 * default byte-identical to the historical host-only build, and — critically —
 * decides whether the macOS ad-hoc re-sign step applies based on the *target*
 * platform rather than the *host*, so cross-building a Linux binary on a mac
 * never tries to `codesign` a Linux ELF.
 */

/**
 * Bun compile target token (e.g. `bun-linux-x64`, `bun-darwin-arm64`,
 * `bun-linux-x64-musl`). Darwin targets always contain the substring
 * `darwin`; that is the signal the ad-hoc re-sign step keys on.
 */
const DARWIN_TARGET_HINT = "darwin";

export interface CompilePlan {
  /**
   * Extra arguments to splice into `bun build --compile` — `["--target", t]`
   * for an explicit cross-target build, or `[]` for the host-default build.
   */
  readonly compileArgs: readonly string[];
  /**
   * Whether to run the macOS ad-hoc re-sign step. True only when the resolved
   * target is a darwin binary (explicit darwin target, or host-default on a
   * darwin host). The shared `sign-cli-bin.ts` helper is itself a no-op when
   * `codesign` is unavailable, so this gate's real job is to STOP signing a
   * non-darwin (e.g. Linux ELF) target that was cross-built on a darwin host.
   */
  readonly shouldSign: boolean;
  /** Human-readable resolved target, for build logging. */
  readonly targetLabel: string;
}

/**
 * Resolve the compile plan from an optional explicit target token and the
 * host platform.
 *
 * - Explicit target (e.g. `PI_ACP_COMPILE_TARGET=bun-linux-x64`): cross-build
 *   for that target; sign only when the target is darwin.
 * - No target: bun compiles for the host; sign only when the host is darwin.
 *   This branch is byte-identical to the historical build behavior.
 */
export function resolveCompilePlan(
  target: string | undefined,
  hostPlatform: NodeJS.Platform,
): CompilePlan {
  const trimmed = target?.trim();
  if (trimmed) {
    return {
      compileArgs: ["--target", trimmed],
      shouldSign: trimmed.includes(DARWIN_TARGET_HINT),
      targetLabel: trimmed,
    };
  }
  return {
    compileArgs: [],
    shouldSign: hostPlatform === "darwin",
    targetLabel: `host (${hostPlatform})`,
  };
}
