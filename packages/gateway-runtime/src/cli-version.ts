/**
 * Helper for CLI bin scripts to read their package's version without
 * triplicating string literals that drift from the actual published version.
 *
 * Usage from a bin script (one level deep, e.g. `packages/foo/src/bin.ts` or
 * `packages/foo/bin/foo.ts`):
 *
 *   import pkg from "../package.json";
 *   import { getCliVersion } from "@agents-js/gateway-runtime";
 *   const VERSION = getCliVersion(pkg);
 *
 * Why this signature: pi-acp and droid-acp ship via `bun build --compile`,
 * which embeds the imported JSON at compile time. A filesystem-based reader
 * keyed off `import.meta.url` would resolve to a `/$bunfs/...` virtual path
 * inside the compiled binary and fail. Letting the caller import its own
 * `package.json` defers resolution to the bundler/module-loader, which works
 * uniformly for source runs (`bun src/bin.ts`), bundled output (tsdown), and
 * compiled binaries (`bun build --compile`).
 */
export function getCliVersion(pkg: { version?: unknown }): string {
  const version = pkg.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("getCliVersion: package.json is missing a non-empty string 'version' field");
  }
  return version;
}
