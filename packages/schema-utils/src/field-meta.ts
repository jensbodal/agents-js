import type { ElicitationSchema, FieldMeta, OneOfEntry, SchemaProperty } from "./types.ts";

export function extractOneOf(record: SchemaProperty | { enum?: string[]; oneOf?: OneOfEntry[] }): {
  titles?: Record<string, string>;
  values?: string[];
} {
  const oneOf = (record as { oneOf?: OneOfEntry[] }).oneOf;
  if (!Array.isArray(oneOf)) {
    return {};
  }
  const values: string[] = [];
  const titles: Record<string, string> = {};
  let hasTitles = false;

  for (const entry of oneOf) {
    if (typeof entry.const !== "string") {
      continue;
    }
    values.push(entry.const);
    if (typeof entry.title === "string") {
      titles[entry.const] = entry.title;
      hasTitles = true;
    }
  }

  return values.length > 0 ? { values, titles: hasTitles ? titles : undefined } : {};
}

export function toFieldMetas(schema: ElicitationSchema): FieldMeta[] {
  const properties = schema.properties ?? {};
  const requiredSet = new Set(schema.required ?? []);

  return Object.entries(properties).flatMap(([name, prop]) => {
    const type = prop.type;
    if (
      type !== "string" &&
      type !== "number" &&
      type !== "integer" &&
      type !== "boolean" &&
      type !== "array"
    ) {
      return [];
    }

    const enumValues = Array.isArray(prop.enum)
      ? prop.enum.filter((v): v is string => typeof v === "string")
      : undefined;
    const items = prop.items;
    const itemEnumValues =
      items && Array.isArray(items.enum)
        ? items.enum.filter((v): v is string => typeof v === "string")
        : undefined;

    const oneOf = extractOneOf(prop);
    const itemOneOf = items ? extractOneOf(items) : {};

    const resolvedEnum =
      type === "array" ? (itemEnumValues ?? itemOneOf.values) : (enumValues ?? oneOf.values);
    const resolvedTitles = type === "array" ? itemOneOf.titles : oneOf.titles;

    return {
      name,
      type,
      title: typeof prop.title === "string" ? prop.title : undefined,
      description: typeof prop.description === "string" ? prop.description : undefined,
      required: requiredSet.has(name),
      enumValues: resolvedEnum,
      oneOfTitles: resolvedTitles,
      multiSelect: type === "array",
    } satisfies FieldMeta;
  });
}
