import type {
  CanvasDoc,
  Citation,
  ComponentNote,
  WorkerEnvelope,
  WorkerFinding,
  WorkerId,
} from "./types.ts";

const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

export function validateWorkerEnvelope(workerId: WorkerId, value: unknown): WorkerEnvelope {
  if (!isRecord(value)) {
    throw new Error(`Worker ${workerId}: output is not an object`);
  }

  if (value.workerId !== workerId) {
    throw new Error(
      `Worker ${workerId}: workerId mismatch, expected ${workerId}, got ${String(value.workerId)}`,
    );
  }

  const findings = ensureArray(value.findings, `Worker ${workerId}: findings must be an array`).map(
    (item) => parseFinding(item, workerId),
  );

  const componentNotes = ensureArray(
    value.componentNotes,
    `Worker ${workerId}: componentNotes must be an array`,
  ).map((item) => parseComponentNote(item, workerId));

  const citations = ensureArray(
    value.citations,
    `Worker ${workerId}: citations must be an array`,
  ).map((item) => parseCitation(item, workerId));

  const allowedKeys = new Set(["workerId", "findings", "componentNotes", "citations"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Worker ${workerId}: unexpected property ${key}`);
    }
  }

  return {
    workerId,
    findings,
    componentNotes,
    citations,
  };
}

function parseFinding(value: unknown, workerId: WorkerId): WorkerFinding {
  if (!isRecord(value)) {
    throw new Error(`Worker ${workerId}: finding entry must be an object`);
  }

  const severity = ensureString(
    value.severity,
    `Worker ${workerId}: finding severity must be a string`,
  );
  if (!SEVERITIES.has(severity)) {
    throw new Error(`Worker ${workerId}: unsupported severity ${severity}`);
  }

  const title = ensureNonEmptyString(value.title, `Worker ${workerId}: finding title is required`);
  const body = ensureNonEmptyString(value.body, `Worker ${workerId}: finding body is required`);

  const file =
    value.file === undefined || value.file === null
      ? undefined
      : ensureNonEmptyString(value.file, "finding file");
  const line =
    value.line === undefined || value.line === null
      ? undefined
      : ensurePositiveInt(value.line, "finding line");
  const confidence =
    value.confidence === undefined || value.confidence === null
      ? undefined
      : ensureNumberInRange(value.confidence, 0, 1, "finding confidence");

  const evidenceRefs = ensureArray(
    value.evidenceRefs,
    `Worker ${workerId}: evidenceRefs must be an array`,
  ).map((item) =>
    ensureNonEmptyString(
      item,
      `Worker ${workerId}: evidenceRefs entries must be non-empty strings`,
    ),
  );

  const allowedKeys = new Set([
    "severity",
    "title",
    "body",
    "file",
    "line",
    "confidence",
    "evidenceRefs",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Worker ${workerId}: unexpected finding property ${key}`);
    }
  }

  return {
    severity: severity as WorkerFinding["severity"],
    title,
    body,
    file,
    line,
    confidence,
    evidenceRefs,
  };
}

function parseComponentNote(value: unknown, workerId: WorkerId): ComponentNote {
  if (!isRecord(value)) {
    throw new Error(`Worker ${workerId}: componentNote entry must be an object`);
  }

  const component = ensureNonEmptyString(
    value.component,
    `Worker ${workerId}: componentNote component is required`,
  );
  const summary = ensureNonEmptyString(
    value.summary,
    `Worker ${workerId}: componentNote summary is required`,
  );

  const allowedKeys = new Set(["component", "summary"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Worker ${workerId}: unexpected componentNote property ${key}`);
    }
  }

  return { component, summary };
}

function parseCitation(value: unknown, workerId: WorkerId): Citation {
  if (!isRecord(value)) {
    throw new Error(`Worker ${workerId}: citation entry must be an object`);
  }

  const sourceId = ensureNonEmptyString(
    value.sourceId,
    `Worker ${workerId}: citation sourceId is required`,
  );
  const url = ensureNonEmptyString(value.url, `Worker ${workerId}: citation url is required`);
  const note = ensureNonEmptyString(value.note, `Worker ${workerId}: citation note is required`);

  const allowedKeys = new Set(["sourceId", "url", "note"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Worker ${workerId}: unexpected citation property ${key}`);
    }
  }

  return { sourceId, url, note };
}

export function validateCanvasDoc(value: unknown): CanvasDoc {
  if (!isRecord(value)) {
    throw new Error("Canvas document must be an object");
  }

  const nodes = ensureArray(value.nodes, "Canvas document must contain nodes[]");
  const edges = ensureArray(value.edges, "Canvas document must contain edges[]");

  const nodeIds = new Set<string>();
  const parsedNodes: CanvasDoc["nodes"] = [];
  const parsedEdges: CanvasDoc["edges"] = [];

  for (const node of nodes) {
    if (!isRecord(node)) {
      throw new Error("Canvas node must be an object");
    }

    const id = ensureNonEmptyString(node.id, "Canvas node id is required");
    const type = ensureString(node.type, "Canvas node type is required");
    if (type !== "text") {
      throw new Error(`Unsupported canvas node type ${type}`);
    }

    ensureNumber(node.x, "Canvas node x must be numeric");
    ensureNumber(node.y, "Canvas node y must be numeric");
    ensureNumber(node.width, "Canvas node width must be numeric");
    ensureNumber(node.height, "Canvas node height must be numeric");
    ensureString(node.text, "Canvas text node text must be a string");

    if (nodeIds.has(id)) {
      throw new Error(`Duplicate canvas node id ${id}`);
    }
    nodeIds.add(id);

    parsedNodes.push({
      id,
      type: "text",
      text: ensureString(node.text, "Canvas text node text must be a string"),
      x: ensureNumber(node.x, "Canvas node x must be numeric"),
      y: ensureNumber(node.y, "Canvas node y must be numeric"),
      width: ensureNumber(node.width, "Canvas node width must be numeric"),
      height: ensureNumber(node.height, "Canvas node height must be numeric"),
    });
  }

  for (const edge of edges) {
    if (!isRecord(edge)) {
      throw new Error("Canvas edge must be an object");
    }

    const fromNode = ensureNonEmptyString(edge.fromNode, "Canvas edge fromNode is required");
    const toNode = ensureNonEmptyString(edge.toNode, "Canvas edge toNode is required");

    if (!nodeIds.has(fromNode)) {
      throw new Error(`Canvas edge references missing fromNode ${fromNode}`);
    }
    if (!nodeIds.has(toNode)) {
      throw new Error(`Canvas edge references missing toNode ${toNode}`);
    }

    parsedEdges.push({
      id:
        edge.id === undefined
          ? `${fromNode}->${toNode}`
          : ensureNonEmptyString(edge.id, "Canvas edge id must be a non-empty string"),
      fromNode,
      toNode,
      fromSide:
        edge.fromSide === undefined
          ? undefined
          : ensureSide(edge.fromSide, "Canvas edge fromSide must be top/right/bottom/left"),
      toSide:
        edge.toSide === undefined
          ? undefined
          : ensureSide(edge.toSide, "Canvas edge toSide must be top/right/bottom/left"),
      label:
        edge.label === undefined
          ? undefined
          : ensureString(edge.label, "Canvas edge label must be a string"),
    });
  }

  return {
    nodes: parsedNodes,
    edges: parsedEdges,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ensureArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function ensureString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}

function ensureNonEmptyString(value: unknown, message: string): string {
  const text = ensureString(value, message);
  if (text.trim().length === 0) {
    throw new Error(message);
  }
  return text;
}

function ensureNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(message);
  }
  return value;
}

function ensurePositiveInt(value: unknown, field: string): number {
  const num = ensureNumber(value, `${field} must be a number`);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return num;
}

function ensureNumberInRange(value: unknown, min: number, max: number, field: string): number {
  const num = ensureNumber(value, `${field} must be a number`);
  if (num < min || num > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return num;
}

function ensureSide(value: unknown, message: string): "top" | "right" | "bottom" | "left" {
  const side = ensureString(value, message);
  if (side !== "top" && side !== "right" && side !== "bottom" && side !== "left") {
    throw new Error(message);
  }
  return side;
}
