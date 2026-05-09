import { afterEach, describe, expect, test } from "bun:test";
import {
  registerRuntimeValidator,
  resetRuntimeValidatorsForTest,
  ValidationError,
  validateRuntimeManifest,
} from "../src/index.ts";

afterEach(() => {
  resetRuntimeValidatorsForTest();
});

describe("validateRuntimeManifest", () => {
  test("uses generic validator when runtime is not registered", () => {
    const output = validateRuntimeManifest(
      {
        name: "codex",
        version: "1.0.0",
      },
      "codex",
    );

    expect(output).toEqual({
      name: "codex",
      version: "1.0.0",
    });
  });

  test("rejects invalid generic runtime manifest", () => {
    expect(() => validateRuntimeManifest({ name: "codex" }, "codex")).toThrow(ValidationError);
  });

  test("uses registered validator", () => {
    registerRuntimeValidator("codex", (input) => {
      if (typeof input !== "object" || input === null || !("provider" in input)) {
        throw new ValidationError("provider is required", {
          field: "runtimeManifest.provider",
          value: input,
        });
      }
    });

    const output = validateRuntimeManifest(
      {
        provider: "openai",
      },
      "codex",
    );

    expect(output).toEqual({ provider: "openai" });
  });
});
