import { describe, expect, test } from "bun:test";
import { extractLastAgentMessage, parseJsonlEvents } from "../src/jsonl.ts";
import type { RepoSnapshot } from "../src/types.ts";
import { runWorkers } from "../src/workers.ts";
import { createMockDeps } from "./helpers.ts";

describe("JSONL parsing", () => {
  test("extracts last agent message from codex stream", () => {
    const raw = [
      "not json",
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "i-1", type: "agent_message", text: '{"status":"first"}' },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "i-2", type: "agent_message", text: '{"status":"last"}' },
      }),
    ].join("\n");

    const events = parseJsonlEvents(raw);
    const message = extractLastAgentMessage(events);
    expect(message).toBe('{"status":"last"}');
  });
});

describe("worker integration", () => {
  test("runs all workers using mocked codex JSONL", async () => {
    const snapshot: RepoSnapshot = {
      gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repoName: "@agents-js/root",
      profileId: "agents-js",
      fileManifest: ["package.json", "packages/a2a/src/server.ts"],
      commands: [],
      components: [
        {
          id: "comp-1",
          path: "packages/a2a/package.json",
          name: "@agents-js/a2a",
        },
      ],
      sources: [
        {
          sourceId: "jsoncanvas_spec",
          url: "https://jsoncanvas.org/spec/1.0/",
          sha256: "abcd",
          normalizedContent: "spec",
        },
      ],
    };

    const deps = createMockDeps();
    const results = await runWorkers(
      {
        repoRoot: ".",
      },
      snapshot,
      deps,
    );

    expect(results).toHaveLength(6);
    expect(results[0]?.workerId).toBe("arch_worker");
    expect(results[5]?.workerId).toBe("spec_worker");
  });

  test("does not pass an unsupported web mode flag to codex", async () => {
    const snapshot: RepoSnapshot = {
      gitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repoName: "@agents-js/root",
      profileId: "agents-js",
      fileManifest: ["package.json", "packages/reporting/src/workers.ts"],
      commands: [],
      components: [
        {
          id: "comp-1",
          path: "packages/reporting/package.json",
          name: "@agents-js/reporting",
        },
      ],
      sources: [],
    };

    const codexArgs: string[][] = [];
    const deps = createMockDeps({
      onCodexRun: (args) => {
        codexArgs.push(args);
      },
    });

    await runWorkers(
      {
        repoRoot: ".",
      },
      snapshot,
      deps,
    );

    expect(codexArgs).toHaveLength(6);
    for (const args of codexArgs) {
      expect(args.includes("--web")).toBe(false);
      expect(args.includes("--search")).toBe(false);
    }
  });
});
