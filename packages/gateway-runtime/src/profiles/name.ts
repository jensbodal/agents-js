/**
 * Profile names appear in filesystem paths (`<profilesRoot>/<runtime>/<name>`),
 * so the accepted character class is intentionally narrow:
 *
 * - lowercase ASCII letters
 * - digits
 * - `_` and `-`
 *
 * No path separators, no whitespace, no shell metacharacters. The leading
 * trim is applied before validation so config-loader errors point at the
 * trimmed value.
 */
const PROFILE_NAME_PATTERN = /^[a-z0-9_-]+$/;

/**
 * Validate a profile name and return the trimmed value. Throws with a
 * human-readable diagnostic if the value is empty or contains characters
 * outside the accepted set.
 *
 * @internal
 */
export function validateRuntimeProfileName(profileName: string): string {
  const normalized = profileName.trim();
  if (!normalized || !PROFILE_NAME_PATTERN.test(normalized)) {
    // Include the offending (original, un-trimmed) value in the error so
    // standalone callers — config loaders, CLI flag parsers — can surface
    // what was actually seen without re-wrapping the error themselves.
    const quoted = JSON.stringify(profileName);
    throw new Error(
      `[agents-js] Runtime profile name ${quoted} is invalid. Profile names must contain only lowercase letters, numbers, "_" or "-".`,
    );
  }
  return normalized;
}
