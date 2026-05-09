/**
 * ACP open-extension properties (used by schema generation).
 *
 * Schema-related constants only. Policy/permission types live in
 * `@agents-js/policy`; this package depends on neither policy nor permission
 * grammar (see `.readme-note.md` for scope).
 */

/** ACP open-extension properties. */
export const ACP_OPEN_EXTENSION_PROPERTIES = ["_meta"] as const;

export function isACPOpenExtensionProperty(propertyName: string): boolean {
  return ACP_OPEN_EXTENSION_PROPERTIES.includes(
    propertyName as (typeof ACP_OPEN_EXTENSION_PROPERTIES)[number],
  );
}
