import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors.ts";
import { validateJsonSchema } from "../src/json-schema.ts";

function expectSchemaToPass(schema: Record<string, unknown>, value: unknown): void {
  expect(() =>
    validateJsonSchema(value, schema, {
      draft: "2020",
      field: "value",
      message: "Invalid numeric format",
      schemaMode: "original",
    }),
  ).not.toThrow();
}

function expectSchemaToFail(schema: Record<string, unknown>, value: unknown): void {
  expect(() =>
    validateJsonSchema(value, schema, {
      draft: "2020",
      field: "value",
      message: "Invalid numeric format",
      schemaMode: "original",
    }),
  ).toThrow(ValidationError);
}

describe("ACP numeric JSON schema formats", () => {
  test("validates uint16 boundaries", () => {
    const schema = { type: "integer", format: "uint16" };

    expectSchemaToPass(schema, 65_535);
    expectSchemaToFail(schema, 65_536);
  });

  test("validates uint32 boundaries", () => {
    const schema = { type: "integer", format: "uint32" };

    expectSchemaToPass(schema, 0);
    expectSchemaToPass(schema, 4_294_967_295);
    expectSchemaToFail(schema, -1);
    expectSchemaToFail(schema, 4_294_967_296);
  });

  test("validates uint64 against the practical safe-integer range", () => {
    const schema = { type: "integer", format: "uint64" };

    expectSchemaToPass(schema, 0);
    expectSchemaToPass(schema, Number.MAX_SAFE_INTEGER);
    expectSchemaToFail(schema, -1);
    expectSchemaToFail(schema, Number.MAX_SAFE_INTEGER + 1);
  });

  test("validates int64 against the practical safe-integer range", () => {
    const schema = { type: "integer", format: "int64" };

    expectSchemaToPass(schema, Number.MIN_SAFE_INTEGER);
    expectSchemaToPass(schema, 0);
    expectSchemaToPass(schema, Number.MAX_SAFE_INTEGER);
    expectSchemaToFail(schema, Number.MIN_SAFE_INTEGER - 1);
    expectSchemaToFail(schema, Number.MAX_SAFE_INTEGER + 1);
  });

  test("validates double as a finite number", () => {
    const schema = { type: "number", format: "double" };

    expectSchemaToPass(schema, 1);
    expectSchemaToPass(schema, 1.5);
    expectSchemaToFail(schema, NaN);
    expectSchemaToFail(schema, Infinity);
    expectSchemaToFail(schema, -Infinity);
  });
});
