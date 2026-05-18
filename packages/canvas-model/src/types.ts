export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

/**
 * Provisional canvas provenance payload. Identity remains caller-owned until
 * the agents-js identity contract lands; this package stores it as inert JSON.
 */
export type CanvasProvenance = JsonObject;

export interface AgentsA2uiExtension {
  type: "@agents-js/a2ui";
  version: "0.1.0";
  inert: true;
  payload: JsonValue;
}

export interface AgentsProvenanceExtension {
  type: "@agents-js/provenance";
  version: "0.1.0";
  payload: CanvasProvenance;
}

export type AgentsCanvasExtension = AgentsA2uiExtension | AgentsProvenanceExtension;

/**
 * Portable agents-js canvas node for an inert A2UI payload.
 */
export interface AgentsCanvasNode {
  id: string;
  kind: "agents-js.a2ui";
  title?: string;
  position: CanvasPoint;
  size: CanvasSize;
  data: AgentsCanvasExtension[];
}

export interface CreateA2uiCanvasNodeOptions {
  id?: string;
  title?: string;
  position?: Partial<CanvasPoint>;
  size?: Partial<CanvasSize>;
  provenance?: Record<string, unknown>;
}

export interface JsonCanvasTextNode {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface JsonCanvasDocument {
  nodes: JsonCanvasTextNode[];
  edges: [];
}

export interface CanvasExportWarning {
  nodeId: string;
  code: "json-canvas-lossy-a2ui";
  message: string;
}

export interface JsonCanvasExportResult {
  canvas: JsonCanvasDocument;
  warnings: CanvasExportWarning[];
}

export interface OcifTextRepresentation {
  mimeType: "text/plain";
  content: string;
}

export interface OcifResource {
  id: string;
  representations: OcifTextRepresentation[];
}

export interface OcifNode {
  id: string;
  position: [number, number];
  size: [number, number];
  resource: string;
  data: JsonObject[];
}

export interface OcifSchemaEntry {
  name: string;
  uri: string;
  schema: JsonObject;
}

export interface OcifDocument {
  ocif: "https://canvasprotocol.org/ocif/v0.7.0";
  nodes: OcifNode[];
  resources: OcifResource[];
  schemas: OcifSchemaEntry[];
}
