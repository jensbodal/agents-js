import { parseSkillYaml, YamlParseError } from "./yaml.ts";

/**
 * Raw split of a SKILL.md document into frontmatter text + body.
 * Returns `null` frontmatter when no valid fence is present so
 * validators can report a specific "no frontmatter" error.
 */
export interface SplitResult {
  frontmatter: string | null;
  body: string;
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;

/**
 * Split a SKILL.md document into its frontmatter fence and markdown
 * body. Accepts CRLF and LF line endings.
 */
export function splitSkillDocument(content: string): SplitResult {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = FRONTMATTER_PATTERN.exec(normalized);

  if (!match) {
    return { frontmatter: null, body: normalized };
  }

  return {
    frontmatter: match[1] ?? "",
    body: match[2] ?? "",
  };
}

/**
 * Parse result for the YAML block. Distinguishes the three failure
 * modes validators care about: no fence, present-but-unparsable, and
 * parsable-but-empty.
 */
export type ParseFrontmatterResult =
  | { kind: "ok"; record: Record<string, unknown>; body: string }
  | { kind: "no-fence"; body: string }
  | { kind: "invalid-yaml"; error: YamlParseError; body: string };

export function parseSkillDocument(content: string): ParseFrontmatterResult {
  const split = splitSkillDocument(content);
  if (split.frontmatter === null) {
    return { kind: "no-fence", body: split.body };
  }

  try {
    const parsed = parseSkillYaml(split.frontmatter);
    return { kind: "ok", record: parsed as Record<string, unknown>, body: split.body };
  } catch (err) {
    if (err instanceof YamlParseError) {
      return { kind: "invalid-yaml", error: err, body: split.body };
    }
    throw err;
  }
}
