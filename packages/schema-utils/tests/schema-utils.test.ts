import { describe, expect, test } from "bun:test";
import { extractOneOf, toFieldMetas } from "../src/index.ts";

describe("extractOneOf", () => {
  test("returns empty for no oneOf", () => {
    expect(extractOneOf({ type: "string" })).toEqual({});
  });

  test("extracts values from oneOf with const", () => {
    const result = extractOneOf({
      oneOf: [
        { const: "a", title: "Option A" },
        { const: "b", title: "Option B" },
      ],
    });
    expect(result.values).toEqual(["a", "b"]);
    expect(result.titles).toEqual({ a: "Option A", b: "Option B" });
  });

  test("returns values without titles when titles are missing", () => {
    const result = extractOneOf({
      oneOf: [{ const: "x" }, { const: "y" }],
    });
    expect(result.values).toEqual(["x", "y"]);
    expect(result.titles).toBeUndefined();
  });

  test("skips non-string const entries", () => {
    const result = extractOneOf({
      oneOf: [{ const: 123 }, { const: "valid" }],
    } as unknown as { oneOf: Array<{ const?: string; title?: string }> });
    expect(result.values).toEqual(["valid"]);
  });

  test("returns empty for non-array oneOf", () => {
    expect(
      extractOneOf({ oneOf: "not-array" as unknown } as {
        oneOf?: Array<{ const?: string; title?: string }>;
      }),
    ).toEqual({});
  });
});

describe("toFieldMetas", () => {
  test("returns empty for no properties", () => {
    expect(toFieldMetas({})).toEqual([]);
  });

  test("extracts string field", () => {
    const fields = toFieldMetas({
      properties: { name: { type: "string", description: "Your name" } },
      required: ["name"],
    });
    expect(fields.length).toBe(1);
    const [field] = fields;
    if (!field) throw new Error("expected one field");
    expect(field.name).toBe("name");
    expect(field.type).toBe("string");
    expect(field.description).toBe("Your name");
    expect(field.required).toBe(true);
  });

  test("extracts boolean field", () => {
    const fields = toFieldMetas({
      properties: { flag: { type: "boolean" } },
    });
    const [field] = fields;
    if (!field) throw new Error("expected one field");
    expect(field.type).toBe("boolean");
    expect(field.required).toBe(false);
  });

  test("extracts enum field from enum keyword", () => {
    const fields = toFieldMetas({
      properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
    });
    const [field] = fields;
    if (!field) throw new Error("expected one field");
    expect(field.enumValues).toEqual(["red", "green", "blue"]);
  });

  test("extracts enum field from oneOf", () => {
    const fields = toFieldMetas({
      properties: {
        size: {
          type: "string",
          oneOf: [
            { const: "s", title: "Small" },
            { const: "l", title: "Large" },
          ],
        },
      },
    });
    const [field] = fields;
    if (!field) throw new Error("expected one field");
    expect(field.enumValues).toEqual(["s", "l"]);
    expect(field.oneOfTitles).toEqual({ s: "Small", l: "Large" });
  });

  test("extracts array field with item enum", () => {
    const fields = toFieldMetas({
      properties: {
        tags: { type: "array", items: { enum: ["a", "b", "c"] } },
      },
    });
    const [field] = fields;
    if (!field) throw new Error("expected one field");
    expect(field.type).toBe("array");
    expect(field.enumValues).toEqual(["a", "b", "c"]);
  });

  test("marks required fields", () => {
    const fields = toFieldMetas({
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
    });
    expect(fields.find((f) => f.name === "a")?.required).toBe(true);
    expect(fields.find((f) => f.name === "b")?.required).toBe(false);
  });

  test("skips unsupported types", () => {
    const fields = toFieldMetas({
      properties: { obj: { type: "object" }, str: { type: "string" } },
    });
    expect(fields.length).toBe(1);
    const [field] = fields;
    if (!field) throw new Error("expected one field");
    expect(field.name).toBe("str");
  });
});
