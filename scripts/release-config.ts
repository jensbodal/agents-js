export const EXPECTED_PUBLISH_ACCESS = "restricted";
export const PUBLISH_SCOPE = "@agents-js";

/** Env var that selects the target npm registry for `@agents-js/*` publishes. */
export const PUBLISH_REGISTRY_ENV = "AGENTS_JS_PUBLISH_REGISTRY";

/**
 * Resolve the target publish registry from the environment.
 *
 * Returns `null` when `AGENTS_JS_PUBLISH_REGISTRY` is unset or blank. Callers
 * decide whether that is fatal (publish mode) or acceptable (read-only audit).
 */
export function resolvePublishRegistry(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[PUBLISH_REGISTRY_ENV]?.trim();
  if (!raw) {
    return null;
  }
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function publishPackageName(dirName: string): string {
  return `${PUBLISH_SCOPE}/${dirName}`;
}
