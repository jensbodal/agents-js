/**
 * parse-env.ts — Type-safe environment variable parser
 *
 * Usage:
 *   import { parseEnv } from '@agents-js/gateway-runtime'
 *
 *   const harness = parseEnv('AJS_DEFAULT_HARNESS').string()           // required string
 *   const port    = parseEnv('PORT', '3000').number()                  // default 3000
 *   const debug   = parseEnv('DEBUG').optional().boolean()             // optional boolean
 *   const model   = parseEnv('AJS_DEFAULT_MODEL').optional().string()  // optional string
 *
 * Custom source (e.g. Vite client-side):
 *   const parseClientEnv = createParseEnv(import.meta.env)
 *   const title = parseClientEnv('VITE_APP_TITLE').string()
 */

import { styleText } from "node:util";

type EnvSource = Record<string, string | undefined>;

class EnvError extends Error {
  readonly variable: string;

  constructor(variable: string, reason: string) {
    const label = styleText("red", "[parseEnv]");
    const name = styleText("bold", variable);
    super(`${label} ${name} ${reason}`);
    this.name = "EnvError";
    this.variable = variable;
  }
}

const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSY = new Set(["false", "0", "no", "off", ""]);

function toNumber(key: string, raw: string): number {
  const num = Number(raw);
  if (Number.isNaN(num)) {
    throw new EnvError(key, `cannot parse "${raw}" as number`);
  }
  return num;
}

function toBoolean(key: string, raw: string): boolean {
  const lower = raw.toLowerCase().trim();
  if (TRUTHY.has(lower)) return true;
  if (FALSY.has(lower)) return false;
  throw new EnvError(
    key,
    `cannot parse "${raw}" as boolean (expected: true/false, 1/0, yes/no, on/off)`,
  );
}

class RequiredEnvVar {
  #key: string;
  #value: string | undefined;

  constructor(key: string, value: string | undefined) {
    this.#key = key;
    this.#value = value;
  }

  #resolve(): string {
    if (this.#value === undefined) {
      throw new EnvError(this.#key, "is required but not set");
    }
    return this.#value;
  }

  optional(): OptionalEnvVar {
    return new OptionalEnvVar(this.#key, this.#value);
  }

  string(): string {
    return this.#resolve();
  }

  number(): number {
    return toNumber(this.#key, this.#resolve());
  }

  boolean(): boolean {
    return toBoolean(this.#key, this.#resolve());
  }
}

class OptionalEnvVar {
  #key: string;
  #value: string | undefined;

  constructor(key: string, value: string | undefined) {
    this.#key = key;
    this.#value = value;
  }

  string(): string | undefined {
    return this.#value;
  }

  number(): number | undefined {
    return this.#value !== undefined ? toNumber(this.#key, this.#value) : undefined;
  }

  boolean(): boolean | undefined {
    return this.#value !== undefined ? toBoolean(this.#key, this.#value) : undefined;
  }
}

function createParseEnv(source: EnvSource) {
  return function parseEnv(key: string, defaultValue?: string): RequiredEnvVar {
    const raw = source[key] ?? defaultValue;
    return new RequiredEnvVar(key, raw);
  };
}

// biome-ignore lint/style/noProcessEnv: the default parser intentionally reads the live process environment for Node entrypoints.
const parseEnv = createParseEnv(process.env);

export type { EnvSource };
export { createParseEnv, EnvError, OptionalEnvVar, parseEnv, RequiredEnvVar };
