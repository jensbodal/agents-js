import { describe, expect, test } from "bun:test";
import { validateCanvasDoc, validateWorkerEnvelope } from "../src/index.ts";

describe("worker envelope validation", () => {
  test("accepts strict valid envelope", () => {
    const envelope = validateWorkerEnvelope("arch_worker", {
      workerId: "arch_worker",
      findings: [
        {
          severity: "P1",
          title: "Bad state",
          body: "Something can break.",
          evidenceRefs: ["local:a"],
          file: "src/app.ts",
          line: 3,
          confidence: 0.7,
        },
      ],
      componentNotes: [{ component: "app", summary: "ok" }],
      citations: [{ sourceId: "x", url: "https://example.com", note: "spec" }],
    });

    expect(envelope.workerId).toBe("arch_worker");
    expect(envelope.findings).toHaveLength(1);
  });

  test("rejects unexpected top-level properties", () => {
    expect(() =>
      validateWorkerEnvelope("arch_worker", {
        workerId: "arch_worker",
        findings: [],
        componentNotes: [],
        citations: [],
        extra: true,
      }),
    ).toThrow();
  });
});

describe("canvas validation", () => {
  test("accepts valid canvas document", () => {
    const doc = validateCanvasDoc({
      nodes: [
        { id: "n-1", type: "text", text: "A", x: 0, y: 0, width: 100, height: 80 },
        { id: "n-2", type: "text", text: "B", x: 200, y: 0, width: 100, height: 80 },
      ],
      edges: [{ id: "e-1", fromNode: "n-1", toNode: "n-2" }],
    });

    expect(doc.nodes).toHaveLength(2);
    expect(doc.edges).toHaveLength(1);
  });

  test("rejects edge referencing missing node", () => {
    expect(() =>
      validateCanvasDoc({
        nodes: [{ id: "n-1", type: "text", text: "A", x: 0, y: 0, width: 100, height: 80 }],
        edges: [{ id: "e-1", fromNode: "n-1", toNode: "n-2" }],
      }),
    ).toThrow("missing toNode");
  });
});
