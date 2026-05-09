import pkg from "../package.json";

/**
 * Build-time constants injected by `bun build --compile --define ...`
 * in `packages/cli/package.json:build:bin`. When running from source via
 * `bun src/cli.ts`, these are undefined and we fall back to the "dev"
 * source-mode banner.
 */
declare const __AGENTS_JS_BUILD_SHA__: string | undefined;
declare const __AGENTS_JS_BUILD_DIRTY__: string | undefined;
declare const __AGENTS_JS_BUILD_DATE__: string | undefined;

const BUILD_SHA = typeof __AGENTS_JS_BUILD_SHA__ === "string" ? __AGENTS_JS_BUILD_SHA__ : "dev";
const BUILD_DIRTY =
  typeof __AGENTS_JS_BUILD_DIRTY__ === "string" ? __AGENTS_JS_BUILD_DIRTY__ === "true" : null;
const BUILD_DATE = typeof __AGENTS_JS_BUILD_DATE__ === "string" ? __AGENTS_JS_BUILD_DATE__ : "dev";

/**
 * Plain-text version string for `agents-js`. Includes the build SHA
 * suffix when running from a compiled binary so shipped artifacts are
 * traceable to a specific commit. Source builds collapse to
 * `agents-js <version> (source)`.
 */
export function formatVersionLine(): string {
  if (BUILD_SHA === "dev") {
    return `agents-js ${pkg.version} (source)`;
  }
  const dirtySuffix = BUILD_DIRTY === true ? "-dirty" : "";
  return `agents-js ${pkg.version} (${BUILD_SHA}${dirtySuffix}, built ${BUILD_DATE})`;
}

/**
 * The bare semver from `package.json`. Used by subcommand help banners
 * (`agents-js v<version> — <subcommand>`).
 */
export const CLI_VERSION = pkg.version;

/**
 * Standard `--version` / `-v` handler. Returns the exit code (always
 * `EXIT_OK`) when the argv contains a version flag; `undefined`
 * otherwise so callers continue with normal parsing.
 */
export function handleVersionFlag(
  argv: string[],
  output: Pick<NodeJS.WriteStream, "write">,
): number | undefined {
  if (argv.includes("--version") || argv.includes("-v")) {
    output.write(`${formatVersionLine()}\n`);
    return 0;
  }
  return undefined;
}
