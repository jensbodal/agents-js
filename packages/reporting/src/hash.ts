import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value: unknown, indent: number = 2): string {
  const normalized = normalizeForStableStringify(value);
  return JSON.stringify(normalized, null, indent);
}

function normalizeForStableStringify(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForStableStringify(item));
  }

  if (value !== null && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input).sort();
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      output[key] = normalizeForStableStringify(input[key]);
    }
    return output;
  }

  return value;
}

export function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
