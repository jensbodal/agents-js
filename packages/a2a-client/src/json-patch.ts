import type { JsonPatchOperation } from "./types.ts";

/**
 * Lightweight JSON Patch (RFC 6902) implementation for immutable state updates.
 *
 * Supports the six standard operations: add, remove, replace, move, copy, test.
 * All operations produce a new object (deep-clone-on-write) without mutating the input.
 */

/** Parse a JSON Pointer (RFC 6901) path into an array of decoded tokens. */
function parsePath(path: string): string[] {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    throw new Error(`Invalid JSON Pointer: "${path}" must start with "/".`);
  }
  return path
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Resolve a token array to the parent container and the final key. */
function resolveParent(
  root: unknown,
  tokens: string[],
): { parent: Record<string, unknown> | unknown[]; key: string } {
  if (tokens.length === 0) {
    throw new Error("Cannot resolve parent of root document.");
  }

  let current: unknown = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i] as string;
    if (Array.isArray(current)) {
      const index = Number.parseInt(token, 10);
      if (Number.isNaN(index) || index < 0 || index >= current.length) {
        throw new Error(
          `Invalid array index "${token}" at path "/${tokens.slice(0, i + 1).join("/")}" (array length: ${current.length}).`,
        );
      }
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      const obj = current as Record<string, unknown>;
      if (!(token in obj)) {
        throw new Error(
          `Path "/${tokens.slice(0, i + 1).join("/")}" does not exist in the target object.`,
        );
      }
      current = obj[token];
    } else {
      throw new Error(
        `Cannot traverse path "/${tokens.slice(0, i + 1).join("/")}" — intermediate value is not an object or array.`,
      );
    }
  }

  const key = tokens[tokens.length - 1] as string;

  if (Array.isArray(current)) {
    return { parent: current, key };
  }

  if (current !== null && typeof current === "object") {
    return { parent: current as Record<string, unknown>, key };
  }

  throw new Error(
    `Cannot resolve parent at path "/${tokens.slice(0, -1).join("/")}" — value is not an object or array.`,
  );
}

/** Get the value at a JSON Pointer path within a document. */
function getValue(root: unknown, tokens: string[]): unknown {
  if (tokens.length === 0) {
    return root;
  }
  const { parent, key } = resolveParent(root, tokens);
  if (Array.isArray(parent)) {
    const index = Number.parseInt(key, 10);
    if (Number.isNaN(index) || index < 0 || index >= parent.length) {
      throw new Error(
        `Invalid array index "${key}" at path "/${tokens.join("/")}" (array length: ${parent.length}).`,
      );
    }
    return parent[index];
  }
  const obj = parent as Record<string, unknown>;
  if (!(key in obj)) {
    throw new Error(
      `Path "/${tokens.join("/")}" does not exist in the target object (key "${key}" not found).`,
    );
  }
  return obj[key];
}

function applyAdd(doc: unknown, tokens: string[], value: unknown): void {
  if (tokens.length === 0) {
    throw new Error('Cannot "add" to the root document via JSON Patch.');
  }
  const { parent, key } = resolveParent(doc, tokens);
  if (Array.isArray(parent)) {
    if (key === "-") {
      parent.push(structuredClone(value));
    } else {
      const index = Number.parseInt(key, 10);
      if (Number.isNaN(index) || index < 0 || index > parent.length) {
        throw new Error(
          `Invalid array index "${key}" for add operation (array length: ${parent.length}).`,
        );
      }
      parent.splice(index, 0, structuredClone(value));
    }
  } else {
    (parent as Record<string, unknown>)[key] = structuredClone(value);
  }
}

function applyRemove(doc: unknown, tokens: string[]): void {
  if (tokens.length === 0) {
    throw new Error('Cannot "remove" the root document via JSON Patch.');
  }
  const { parent, key } = resolveParent(doc, tokens);
  if (Array.isArray(parent)) {
    const index = Number.parseInt(key, 10);
    if (Number.isNaN(index) || index < 0 || index >= parent.length) {
      throw new Error(
        `Invalid array index "${key}" for remove operation (array length: ${parent.length}).`,
      );
    }
    parent.splice(index, 1);
  } else {
    const obj = parent as Record<string, unknown>;
    if (!(key in obj)) {
      throw new Error(`Cannot remove non-existent key "${key}" at path "/${tokens.join("/")}".`);
    }
    delete obj[key];
  }
}

function applyReplace(doc: unknown, tokens: string[], value: unknown): void {
  if (tokens.length === 0) {
    throw new Error('Cannot "replace" the root document via JSON Patch.');
  }
  const { parent, key } = resolveParent(doc, tokens);
  if (Array.isArray(parent)) {
    const index = Number.parseInt(key, 10);
    if (Number.isNaN(index) || index < 0 || index >= parent.length) {
      throw new Error(
        `Invalid array index "${key}" for replace operation (array length: ${parent.length}).`,
      );
    }
    parent[index] = structuredClone(value);
  } else {
    const obj = parent as Record<string, unknown>;
    if (!(key in obj)) {
      throw new Error(`Cannot replace non-existent key "${key}" at path "/${tokens.join("/")}".`);
    }
    obj[key] = structuredClone(value);
  }
}

function applyTest(doc: unknown, tokens: string[], value: unknown): void {
  const actual = getValue(doc, tokens);
  const expected = JSON.stringify(value);
  const actualStr = JSON.stringify(actual);
  if (actualStr !== expected) {
    throw new Error(
      `JSON Patch test failed at path "/${tokens.join("/")}": expected ${expected}, got ${actualStr}.`,
    );
  }
}

/**
 * Apply an array of JSON Patch (RFC 6902) operations to a state object immutably.
 *
 * Returns a new state object with all operations applied. The input state is not modified.
 * Throws descriptive errors for invalid operations (missing paths, type mismatches, failed tests).
 */
export function applyJsonPatch<T>(state: T, operations: JsonPatchOperation[]): T {
  if (operations.length === 0) {
    return state;
  }

  const doc = structuredClone(state);

  for (const op of operations) {
    const tokens = parsePath(op.path);

    switch (op.op) {
      case "add":
        if (!("value" in op)) {
          throw new Error('"add" operation requires a "value" field.');
        }
        applyAdd(doc, tokens, op.value);
        break;
      case "remove":
        applyRemove(doc, tokens);
        break;
      case "replace":
        if (!("value" in op)) {
          throw new Error('"replace" operation requires a "value" field.');
        }
        applyReplace(doc, tokens, op.value);
        break;
      case "move": {
        if (op.from === undefined) {
          throw new Error('"move" operation requires a "from" field.');
        }
        const fromTokens = parsePath(op.from);
        const value = getValue(doc, fromTokens);
        applyRemove(doc, fromTokens);
        applyAdd(doc, tokens, value);
        break;
      }
      case "copy": {
        if (op.from === undefined) {
          throw new Error('"copy" operation requires a "from" field.');
        }
        const fromTokens = parsePath(op.from);
        const value = getValue(doc, fromTokens);
        applyAdd(doc, tokens, value);
        break;
      }
      case "test":
        if (!("value" in op)) {
          throw new Error('"test" operation requires a "value" field.');
        }
        applyTest(doc, tokens, op.value);
        break;
      default:
        throw new Error(`Unknown JSON Patch operation: "${(op as { op: string }).op}".`);
    }
  }

  return doc;
}
