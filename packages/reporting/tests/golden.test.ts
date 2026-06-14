import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildCanvas } from "../src/canvas.ts";
import { stableStringify } from "../src/hash.ts";
import { renderFindingsMarkdown } from "../src/markdown.ts";
import type { Finding, RepoSnapshot, WorkerResult } from "../src/types.ts";

const snapshot: RepoSnapshot = {
  gitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  repoName: "@agents-js/root",
  profileId: "agents-js",
  fileManifest: ["package.json", "packages/a2a/src/server.ts", "packages/acp/src/connection.ts"],
  commands: [],
  components: [
    {
      id: "c-a2a",
      path: "packages/a2a/package.json",
      name: "@agents-js/a2a",
    },
    {
      id: "c-acp",
      path: "packages/acp/package.json",
      name: "@agents-js/acp",
    },
  ],
  sources: [
    {
      sourceId: "jsoncanvas_spec",
      url: "https://jsoncanvas.org/spec/1.0/",
      sha256: "hash-jsoncanvas",
      normalizedContent: "jsoncanvas spec",
    },
  ],
};

const findings: Finding[] = [
  {
    id: "f-abc",
    severity: "P1",
    title: "Session map race",
    body: "Concurrent prompts can interleave shared mutable state.",
    file: "packages/a2a/src/executor.ts",
    line: 35,
    confidence: 0.92,
    evidenceRefs: ["local:executor-35"],
    fingerprint: "fp-1",
    workerIds: ["runtime_worker"],
  },
  {
    id: "f-def",
    severity: "P2",
    title: "Stale path in docs",
    body: "Documentation references app path that no longer exists.",
    file: "mise.toml",
    line: 6,
    confidence: 0.81,
    evidenceRefs: ["local:mise-6"],
    fingerprint: "fp-2",
    workerIds: ["config_docs_worker"],
  },
];

const workerResults: WorkerResult[] = [
  {
    workerId: "runtime_worker",
    schemaPath: "runtime.schema.json",
    prompt: "",
    rawJsonl: "",
    envelope: {
      workerId: "runtime_worker",
      findings: [],
      componentNotes: [{ component: "@agents-js/a2a", summary: "Executor bridges ACP sessions." }],
      citations: [
        { sourceId: "jsoncanvas_spec", url: "https://jsoncanvas.org/spec/1.0/", note: "used" },
      ],
    },
  },
];

describe("golden outputs", () => {
  test("markdown output matches fixture", async () => {
    const rendered = renderFindingsMarkdown(snapshot, findings, workerResults);
    const expected = await readFile(
      join(import.meta.dir, "fixtures", "golden-findings.md"),
      "utf8",
    );
    expect(rendered).toBe(expected);
  });

  test("canvas output matches fixture", async () => {
    const canvas = buildCanvas(snapshot, findings);
    const rendered = `${stableStringify(canvas, 2)}\n`;
    const expected = await readFile(
      join(import.meta.dir, "fixtures", "golden-canvas.json"),
      "utf8",
    );
    expect(rendered).toBe(expected);
  });
});
