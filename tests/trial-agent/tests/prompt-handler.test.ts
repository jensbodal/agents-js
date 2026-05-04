import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { defaultRegistry, registerBuiltins, type ToolDefinition } from "@agents-js/tools";
import { classifyPromptIntent, createPromptHandler } from "../src/prompt-handler.ts";

const FIXTURE_WS = path.resolve(import.meta.dir, "fixtures/workspace");
const FIXTURE_HUB = path.resolve(import.meta.dir, "fixtures/hub");

let preTestTools: ToolDefinition[] = [];
beforeAll(() => {
  preTestTools = defaultRegistry.list();
  registerBuiltins();
});
afterAll(() => {
  defaultRegistry.clear();
  for (const tool of preTestTools) {
    defaultRegistry.register(tool);
  }
});

describe("classifyPromptIntent", () => {
  test("recognises /fetch shorthand", () => {
    expect(classifyPromptIntent("/fetch time estimates")).toEqual({
      kind: "fetch-context",
      query: "time estimates",
    });
  });

  test("recognises 'fetch context about <query>'", () => {
    expect(classifyPromptIntent("fetch context about review time")).toEqual({
      kind: "fetch-context",
      query: "review time",
    });
  });

  test("recognises 'what do you know about <query>'", () => {
    expect(classifyPromptIntent("what do you know about release process")).toEqual({
      kind: "fetch-context",
      query: "release process",
    });
  });

  test("recognises /tools shorthand and find-tools forms", () => {
    expect(classifyPromptIntent("/tools search hub")).toEqual({
      kind: "find-tools",
      query: "search hub",
    });
    expect(classifyPromptIntent("find tools for memory recall")).toEqual({
      kind: "find-tools",
      query: "memory recall",
    });
  });

  test("recognises /gates and 'run gates'", () => {
    expect(classifyPromptIntent("/gates")).toEqual({ kind: "run-gates" });
    expect(classifyPromptIntent("run gates")).toEqual({ kind: "run-gates" });
    expect(classifyPromptIntent("run readiness gates")).toEqual({
      kind: "run-gates",
    });
  });

  test("falls back to unknown for unrecognised prompts", () => {
    expect(classifyPromptIntent("hello world")).toEqual({
      kind: "unknown",
      raw: "hello world",
    });
  });
});

describe("createPromptHandler dispatch", () => {
  const handle = createPromptHandler({
    workspaceRoot: FIXTURE_WS,
    hubRoot: FIXTURE_HUB,
  });

  test("fetch-context dispatch returns FetchContextResult shape", async () => {
    const result = await handle("/fetch time estimates");
    expect(result.intent.kind).toBe("fetch-context");
    if (result.data.kind !== "fetch-context") throw new Error("wrong kind");
    expect(Array.isArray(result.data.result.snippets)).toBe(true);
    expect(Array.isArray(result.data.result.sources)).toBe(true);
    expect(result.text).toContain("fetchContext");
  });

  test("fetch-context surfaces hub-file source with absolute path", async () => {
    const result = await handle("fetch context about time estimates");
    if (result.data.kind !== "fetch-context") throw new Error("wrong kind");
    const hubFile = result.data.result.sources.find((s) => s.source_type === "hub-file");
    expect(hubFile).toBeDefined();
    expect(hubFile?.source_ref.startsWith("/")).toBe(true);
    expect(hubFile?.confidence).toBe("responsible");
  });

  test("find-tools dispatch returns matching tools", async () => {
    const result = await handle("/tools search hub for X");
    if (result.data.kind !== "find-tools") throw new Error("wrong kind");
    expect(result.data.tools.length).toBeGreaterThan(0);
    expect(result.data.tools.length).toBeLessThanOrEqual(3);
    const top = result.data.tools[0];
    expect(top?.name).toBe("searchDocs");
  });

  test("run-gates dispatch returns a structured GateReport", async () => {
    const result = await handle("/gates");
    if (result.data.kind !== "run-gates") throw new Error("wrong kind");
    expect(result.data.report.results).toHaveLength(7);
    expect(result.text).toContain("Readiness gates");
  });

  test("unknown dispatch returns help text", async () => {
    const result = await handle("hi there");
    if (result.data.kind !== "help") throw new Error("wrong kind");
    expect(result.data.message).toContain("trial-agent");
    expect(result.text).toContain("Try one of");
  });
});
