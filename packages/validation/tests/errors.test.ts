import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors.ts";

describe("ValidationError", () => {
  test("creates error with field and value context", () => {
    const err = new ValidationError("must be positive", { field: "port", value: -1 });
    expect(err.message).toBe('Validation failed for "port": must be positive');
    expect(err.field).toBe("port");
    expect(err.value).toBe(-1);
    expect(err.name).toBe("ValidationError");
  });

  test("is instanceof Error", () => {
    const err = new ValidationError("bad", { field: "field", value: null });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ValidationError);
  });

  test("captures stack trace", () => {
    const err = new ValidationError("test", { field: "x", value: 0 });
    expect(err.stack).toBeDefined();
  });
});
