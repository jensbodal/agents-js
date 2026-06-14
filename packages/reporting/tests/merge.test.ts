import { describe, expect, test } from "bun:test";
import { mergeFindings } from "../src/merge.ts";
import type { WorkerResult } from "../src/types.ts";
import { buildEnvelope } from "./helpers.ts";

function workerResult(
  workerId: WorkerResult["workerId"],
  findingTitle: string,
  severity: "P0" | "P1" | "P2" | "P3",
): WorkerResult {
  return {
    workerId,
    schemaPath: `/schemas/${workerId}.schema.json`,
    prompt: "p",
    rawJsonl: "",
    envelope: buildEnvelope(workerId, [
      {
        severity,
        title: findingTitle,
        body: `body:${findingTitle}`,
        file: "packages/a2a/src/server.ts",
        line: 12,
        evidenceRefs: ["local:1"],
      },
    ]),
  };
}

describe("mergeFindings", () => {
  test("dedupes by deterministic fingerprint", () => {
    const merged = mergeFindings([
      workerResult("arch_worker", "Same bug", "P1"),
      workerResult("runtime_worker", "Same bug", "P1"),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.workerIds).toEqual(["arch_worker", "runtime_worker"]);
  });

  test("dedupes across workers citing disjoint evidenceRefs", () => {
    // Two workers describe the same issue (same severity/title/file/line)
    // but cite different evidence. Per the README contract, these are the
    // same issue and should merge into one Finding with unioned workerIds
    // and unioned evidenceRefs.
    const sharedIdentity = {
      severity: "P1" as const,
      title: "Same bug",
      body: "body:Same bug",
      file: "packages/a2a/src/server.ts",
      line: 12,
    };
    const merged = mergeFindings([
      {
        workerId: "arch_worker",
        schemaPath: "/schemas/arch_worker.schema.json",
        prompt: "p",
        rawJsonl: "",
        envelope: buildEnvelope("arch_worker", [
          { ...sharedIdentity, evidenceRefs: ["arch:source-line-12"] },
        ]),
      },
      {
        workerId: "runtime_worker",
        schemaPath: "/schemas/runtime_worker.schema.json",
        prompt: "p",
        rawJsonl: "",
        envelope: buildEnvelope("runtime_worker", [
          { ...sharedIdentity, evidenceRefs: ["runtime:test-case-3"] },
        ]),
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.workerIds).toEqual(["arch_worker", "runtime_worker"]);
    expect(merged[0]?.evidenceRefs).toEqual(["arch:source-line-12", "runtime:test-case-3"]);
  });

  test("sorts by severity then file/line/title", () => {
    const merged = mergeFindings([
      workerResult("arch_worker", "z", "P2"),
      workerResult("runtime_worker", "a", "P0"),
      workerResult("test_worker", "b", "P1"),
    ]);

    expect(merged.map((finding) => finding.severity)).toEqual(["P0", "P1", "P2"]);
  });
});
