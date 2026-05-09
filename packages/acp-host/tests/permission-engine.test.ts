import { beforeEach, describe, expect, test } from "bun:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { PermissionEngine } from "../src/permission-engine.ts";

function makeRequest(toolName: string, args?: Record<string, unknown>): RequestPermissionRequest {
  return {
    sessionId: "test-session",
    toolCall: {
      toolCallId: "tc-1",
      title: toolName,
      rawInput: args,
    },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
  };
}

/**
 * Tests for the PermissionEngine wrapper class.
 *
 * These tests cover stateful wrapper behavior only: loadRules migration,
 * add/remove/clear operations, and evaluate integration through the wrapper.
 * Pure policy logic (classifyOperation, scopeMatches, isHighRisk, etc.)
 * is tested in packages/policy/tests/permission-engine.test.ts.
 */
describe("PermissionEngine", () => {
  let engine: PermissionEngine;

  beforeEach(() => {
    engine = new PermissionEngine();
  });

  test("returns no match when no rules exist", () => {
    const result = engine.evaluate(
      makeRequest("readFile", { path: "/workspace/test.md" }),
      "test-agent",
      "/workspace",
    );
    expect(result.matched).toBe(false);
  });

  test("matches a rule by agent, workspace, operation, and scope", () => {
    const request = makeRequest("readFile", { path: "/workspace/test.md" });
    const rule = engine.createRule(
      request,
      "test-agent",
      "/workspace",
      "allow",
      "session",
      "allow",
    );
    engine.addRule(rule);

    const result = engine.evaluate(request, "test-agent", "/workspace");
    expect(result.matched).toBe(true);
    expect(result.rule?.outcome).toBe("allow");
  });

  test("clearSessionRules removes session rules, keeps persistent", () => {
    const request = makeRequest("readFile", { path: "/workspace/a.md" });
    const sessionRule = engine.createRule(
      request,
      "test-agent",
      "/workspace",
      "allow",
      "session",
      "allow",
    );
    const persistentRule = engine.createRule(
      request,
      "test-agent",
      "/workspace",
      "allow",
      "persistent",
      "allow",
    );
    engine.addRule(sessionRule);
    engine.addRule(persistentRule);

    expect(engine.getRules().length).toBe(2);
    engine.clearSessionRules();
    expect(engine.getRules().length).toBe(1);
    expect(engine.getRules()[0]?.lifetime).toBe("persistent");
  });

  test("removeRule removes by ID", () => {
    const request = makeRequest("readFile", { path: "/workspace/test.md" });
    const rule = engine.createRule(
      request,
      "test-agent",
      "/workspace",
      "allow",
      "session",
      "allow",
    );
    engine.addRule(rule);

    expect(engine.removeRule(rule.id)).toBe(true);
    expect(engine.getRules().length).toBe(0);
  });

  test("removeRule returns false for unknown ID", () => {
    expect(engine.removeRule("nonexistent")).toBe(false);
  });

  test("clearAll removes all rules", () => {
    const request = makeRequest("readFile");
    engine.addRule(engine.createRule(request, "a", "/v", "allow", "session", "allow"));
    engine.addRule(engine.createRule(request, "b", "/v", "allow", "persistent", "allow"));
    engine.clearAll();
    expect(engine.getRules().length).toBe(0);
  });

  test("clearConsumedOnceRules removes consumed once-rules", () => {
    const request = makeRequest("readFile", { path: "/workspace/test.md" });
    const rule = engine.createRule(request, "test-agent", "/workspace", "allow", "once", "allow");
    engine.addRule(rule);

    const result = engine.evaluate(request, "test-agent", "/workspace");
    expect(result.matched).toBe(true);

    engine.clearConsumedOnceRules();
    expect(engine.getRules().length).toBe(0);
  });

  test("clearConsumedOnceRules keeps unconsumed once-rules", () => {
    const request = makeRequest("readFile", { path: "/workspace/test.md" });
    const rule = engine.createRule(request, "test-agent", "/workspace", "allow", "once", "allow");
    engine.addRule(rule);

    // Don't evaluate - rule is not consumed
    engine.clearConsumedOnceRules();
    expect(engine.getRules().length).toBe(1);
  });

  test("does not auto-match allow rules when the remembered option is missing", () => {
    const request = makeRequest("readFile", { path: "/workspace/test.md" });
    const rule = engine.createRule(
      request,
      "test-agent",
      "/workspace",
      "allow",
      "persistent",
      "allow",
    );
    engine.addRule(rule);

    const differentOptionRequest = {
      ...request,
      options: [{ optionId: "different", name: "Different", kind: "allow_once" as const }],
    };

    const result = engine.evaluate(differentOptionRequest, "test-agent", "/workspace");
    expect(result.matched).toBe(false);
  });

  test("matches reject rules without requiring an option id", () => {
    const request = makeRequest("writeFile", { path: "/workspace/test.md" });
    const rule = engine.createRule(request, "test-agent", "/workspace", "reject", "persistent");
    engine.addRule(rule);

    const result = engine.evaluate(request, "test-agent", "/workspace");
    expect(result.matched).toBe(true);
    expect(result.rule?.outcome).toBe("reject");
  });

  test("loadRules migrates legacy vaultPath to workspacePath", () => {
    const legacyRules = [
      {
        id: "rule-1",
        agentName: "test-agent",
        vaultPath: "/old-vault",
        workspacePath: "",
        operationClass: "file.read",
        resourceScope: "*",
        lifetime: "persistent" as const,
        outcome: "allow" as const,
        selectedOptionId: "allow",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        expiresAt: null,
        creationSource: "user_prompt" as const,
      },
    ];

    engine.loadRules(
      legacyRules as unknown as import("@agents-js/policy/permission-types").PermissionRule[],
    );
    const rules = engine.getRules();
    expect(rules.length).toBe(1);
    expect(rules[0]?.workspacePath).toBe("/old-vault");
  });

  test("loadRules preserves workspacePath when already set", () => {
    engine.loadRules([
      {
        id: "rule-1",
        agentName: "test-agent",
        workspacePath: "/my-workspace",
        operationClass: "file.read",
        resourceScope: "*",
        lifetime: "persistent",
        outcome: "allow",
        selectedOptionId: "allow",
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        expiresAt: null,
        creationSource: "user_prompt",
      },
    ]);

    const rules = engine.getRules();
    expect(rules[0]?.workspacePath).toBe("/my-workspace");
  });

  test("createRule passes scopeOverride through to created rule", () => {
    const request = makeRequest("writeFile", { path: "/workspace/original.md" });
    const rule = engine.createRule(
      request,
      "test-agent",
      "/workspace",
      "allow",
      "session",
      "allow",
      "/workspace/overridden/",
    );
    expect(rule.resourceScope).toBe("/workspace/overridden/");
  });

  test("createRule uses extracted scope when scopeOverride is not provided", () => {
    const request = makeRequest("writeFile", { path: "/workspace/test.md" });
    const rule = engine.createRule(
      request,
      "test-agent",
      "/workspace",
      "allow",
      "session",
      "allow",
    );
    expect(rule.resourceScope).toBe("/workspace/test.md");
  });
});
