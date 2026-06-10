/**
 * Shared `PATH`-merge helper for ACP process spawning.
 *
 * Both the host-side minimal-env builder (`@agents-js/acp-host`) and the
 * gateway runtime command resolver (`@agents-js/gateway-runtime`) need to graft
 * extra bin directories onto a base `PATH` while preserving order and dropping
 * duplicates/empties. This is the single source of truth for that merge; the
 * gateway runtime layers its default bin paths on top by passing them through
 * `extraBinPaths`.
 */

/**
 * Merge `extraBinPaths` onto a colon-delimited `basePath`, de-duplicating while
 * preserving first-seen order. Existing entries keep their position; new
 * entries append in list order. Empty segments (e.g. a trailing `:` or a blank
 * extra) are skipped.
 */
export function mergeBinPaths(
  basePath: string | undefined,
  extraBinPaths?: readonly string[],
): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  const append = (segment: string): void => {
    if (!segment || seen.has(segment)) return;
    seen.add(segment);
    merged.push(segment);
  };

  if (basePath) {
    for (const segment of basePath.split(":")) {
      append(segment);
    }
  }
  if (extraBinPaths) {
    for (const segment of extraBinPaths) {
      append(segment);
    }
  }

  return merged.join(":");
}
