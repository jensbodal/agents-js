import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const validationRoot = join(import.meta.dir, "..");

const sourceExports = [
  ["@agents-js/validation", "src/index.ts"],
  ["@agents-js/validation/a2a", "src/a2a.ts"],
  ["@agents-js/validation/a2a-metadata", "src/a2a-metadata.ts"],
  ["@agents-js/validation/a2ui", "src/a2ui.ts"],
  ["@agents-js/validation/acp", "src/acp.ts"],
  ["@agents-js/validation/agui", "src/agui.ts"],
  ["@agents-js/validation/errors", "src/errors.ts"],
  ["@agents-js/validation/loader", "src/loader.ts"],
  ["@agents-js/validation/registry", "src/registry.ts"],
] as const;

describe("Bun workspace export resolution", () => {
  for (const [specifier, sourcePath] of sourceExports) {
    test(`${specifier} resolves to source under Bun`, () => {
      const resolved = Bun.resolveSync(specifier, validationRoot);

      expect(resolved).toBe(join(validationRoot, sourcePath));
    });
  }
});
