/**
 * Schema property definition shape used for field rendering.
 * Mirrors the inner values of ACPA2AElicitationSchema.properties.
 */
export interface SchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  items?: { enum?: string[]; oneOf?: OneOfEntry[] };
  oneOf?: OneOfEntry[];
}

export interface OneOfEntry {
  const?: string;
  title?: string;
}

/**
 * Parsed field metadata used internally for rendering and validation.
 */
export interface FieldMeta {
  name: string;
  type: string;
  title?: string;
  description?: string;
  required: boolean;
  enumValues?: string[];
  oneOfTitles?: Record<string, string>;
  multiSelect: boolean;
}

/**
 * Shape of the schema prop — matches ACPA2AElicitationSchema from a2a-client.
 */
export interface ElicitationSchema {
  title?: string | null;
  description?: string | null;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}
