export interface FrontmatterWriteTarget {
  nextFrontmatter: Record<string, unknown>;
}

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;

export function splitMarkdownFrontmatter(content: string): {
  body: string;
  frontmatter: string | null;
} {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = FRONTMATTER_PATTERN.exec(normalized);

  if (!match) {
    return {
      body: normalized,
      frontmatter: null,
    };
  }

  return {
    frontmatter: match[1] ?? "",
    body: match[2] ?? "",
  };
}

export function detectFrontmatterOnlyWrite(
  currentContent: string,
  nextContent: string,
  parseFrontmatter: (yaml: string) => unknown,
): FrontmatterWriteTarget | null {
  const current = splitMarkdownFrontmatter(currentContent);
  const next = splitMarkdownFrontmatter(nextContent);

  if (!current.frontmatter || !next.frontmatter) {
    return null;
  }

  if (current.body !== next.body) {
    return null;
  }

  const parsed = parseFrontmatter(next.frontmatter);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return {
    nextFrontmatter: parsed as Record<string, unknown>,
  };
}
