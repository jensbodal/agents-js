/**
 * Minimal YAML subset parser for SKILL.md frontmatter.
 *
 * SKILL.md files in practice use only a tiny slice of YAML: top-level
 * key-scalar pairs, quoted scalars, inline flow arrays, and block
 * arrays. This parser accepts that subset and rejects everything
 * else, which keeps the package zero-dependency.
 *
 * Callers that need richer YAML (nested maps, anchors, multi-document,
 * flow maps) must pre-parse with a full YAML library and hand us the
 * resulting record via a different code path.
 */

export class YamlParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`YAML parse error on line ${line}: ${message}`);
    this.name = "YamlParseError";
    this.line = line;
  }
}

type Scalar = string | number | boolean | null;
type Value = Scalar | Scalar[];

const KEY_LINE = /^([A-Za-z0-9_-]+):(?:\s+(.*))?\s*$/;
const BLOCK_ITEM = /^\s*-\s+(.*)\s*$/;

/**
 * Parse a YAML frontmatter string (the text between the opening and
 * closing `---` delimiters, excluding those delimiters) into a
 * key-value record.
 */
export function parseSkillYaml(raw: string): Record<string, Value> {
  const out: Record<string, Value> = {};
  const lines = raw.split("\n");

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? "";
    const line = stripComment(rawLine);
    const lineNumber = i + 1;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (line.startsWith(" ") || line.startsWith("\t")) {
      throw new YamlParseError(`unexpected indented line: ${rawLine}`, lineNumber);
    }

    const match = KEY_LINE.exec(line);
    if (!match) {
      throw new YamlParseError(`expected 'key: value' form, got: ${rawLine}`, lineNumber);
    }

    const key = match[1] as string;
    const inlineValue = match[2];

    if (inlineValue === undefined || inlineValue.trim() === "") {
      const items: Scalar[] = [];
      let j = i + 1;
      let consumedBlock = false;
      while (j < lines.length) {
        const nextLine = lines[j] ?? "";
        if (nextLine.trim() === "") {
          j += 1;
          continue;
        }
        const blockMatch = BLOCK_ITEM.exec(nextLine);
        if (!blockMatch) {
          break;
        }
        consumedBlock = true;
        items.push(parseScalar(blockMatch[1] ?? "", j + 1));
        j += 1;
      }
      out[key] = consumedBlock ? items : null;
      i = j;
      continue;
    }

    out[key] = parseValue(inlineValue, lineNumber);
    i += 1;
  }

  return out;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const ch = line[idx];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      if (idx === 0 || /\s/.test(line[idx - 1] ?? "")) {
        return line.slice(0, idx).trimEnd();
      }
    }
  }
  return line;
}

function parseValue(raw: string, lineNumber: number): Value {
  const trimmed = raw.trim();

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return splitFlowArray(inner, lineNumber).map((part) => parseScalar(part, lineNumber));
  }

  return parseScalar(trimmed, lineNumber);
}

function splitFlowArray(inner: string, lineNumber: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let idx = 0; idx < inner.length; idx += 1) {
    const ch = inner[idx];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[") depth += 1;
      else if (ch === "]") depth -= 1;
      else if (ch === "," && depth === 0) {
        parts.push(inner.slice(start, idx).trim());
        start = idx + 1;
      }
    }
  }
  if (depth !== 0) {
    throw new YamlParseError("unbalanced brackets in flow array", lineNumber);
  }
  parts.push(inner.slice(start).trim());
  return parts.filter((p) => p.length > 0);
}

function parseScalar(raw: string, lineNumber: number): Scalar {
  const trimmed = raw.trim();

  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unquoteDouble(trimmed.slice(1, -1), lineNumber);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  if (/^-?\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    const n = Number.parseFloat(trimmed);
    if (Number.isFinite(n)) return n;
  }

  return trimmed;
}

function unquoteDouble(inner: string, lineNumber: number): string {
  let out = "";
  for (let idx = 0; idx < inner.length; idx += 1) {
    const ch = inner[idx];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = inner[idx + 1];
    if (next === undefined) {
      throw new YamlParseError("trailing backslash in double-quoted string", lineNumber);
    }
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "/":
        out += "/";
        break;
      default:
        out += `\\${next}`;
        break;
    }
    idx += 1;
  }
  return out;
}
