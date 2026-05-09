import type { SkillFrontmatter } from "../types.ts";

/**
 * Convert a permissively-parsed YAML record into the canonical
 * {@link SkillFrontmatter} shape. Unknown keys are preserved on the
 * `extra` field. Array fields with non-array input are coerced to an
 * empty array rather than throwing — tolerant validation is the
 * source of truth for "is this skill legal".
 *
 * Kebab-case frontmatter keys (`allowed-tools`, `depends-on`) are
 * renamed to camelCase so downstream consumers get a JS-idiomatic
 * shape.
 */
export function normalizeFrontmatter(record: Record<string, unknown>): SkillFrontmatter {
  const name = asString(record.name) ?? "";
  const description = asString(record.description) ?? "";

  const out: SkillFrontmatter = {
    name,
    description,
    extra: {},
  };

  const license = asString(record.license);
  if (license !== undefined) out.license = license;

  const compatibility = asString(record.compatibility);
  if (compatibility !== undefined) out.compatibility = compatibility;

  const allowedTools = asStringArray(record["allowed-tools"]);
  if (allowedTools !== undefined) out.allowedTools = allowedTools;

  const aliases = asStringArray(record.aliases);
  if (aliases !== undefined) out.aliases = aliases;

  const dependsOn = asStringArray(record["depends-on"]);
  if (dependsOn !== undefined) out.dependsOn = dependsOn;

  const reserved = new Set([
    "name",
    "description",
    "license",
    "allowed-tools",
    "compatibility",
    "aliases",
    "depends-on",
  ]);
  for (const [key, value] of Object.entries(record)) {
    if (!reserved.has(key)) {
      out.extra[key] = value;
    }
  }

  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string");
  return items.length === value.length ? items : undefined;
}
