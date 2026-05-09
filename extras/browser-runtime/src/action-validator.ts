import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ACTION_SCHEMA, type Action } from "./action-schema.ts";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  valid: boolean;
  errors: ValidationIssue[];
  data?: T;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = ajv.compile(ACTION_SCHEMA);

export function validateAction(value: unknown): ValidationResult<Action> {
  const ok = compiled(value);
  if (ok) return { valid: true, errors: [], data: value as Action };
  const errors: ValidationIssue[] = (compiled.errors ?? []).map((e) => ({
    path: e.instancePath || "$",
    message: `${e.keyword}: ${e.message ?? ""}`,
  }));
  return { valid: false, errors };
}

const FENCE_RE = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/m;

export function coerceAction(raw: string): ValidationResult<Action> {
  let text = raw.trim();

  const fenceMatch = text.match(FENCE_RE);
  if (fenceMatch?.[1]) text = fenceMatch[1].trim();

  // Find first '{' and last '}' — strip leading/trailing prose
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return { valid: false, errors: [{ path: "$", message: "no JSON object found" }] };
  }
  const candidate = text.slice(start, end + 1);

  try {
    const parsed = JSON.parse(candidate);
    return validateAction(parsed);
  } catch (err) {
    return {
      valid: false,
      errors: [{ path: "$", message: `JSON parse failed: ${(err as Error).message}` }],
    };
  }
}
