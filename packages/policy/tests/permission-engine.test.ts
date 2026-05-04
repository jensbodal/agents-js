import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import {
  classifyOperation,
  createPermissionRule,
  createRememberedRule,
  evaluatePermissionRules,
  extractResourceScope,
  filterConsumedOnceRules,
  filterExpiredRules,
  filterSessionRules,
  generateScopeCandidates,
  isHighRisk,
  isReadOnly,
  scopeMatches,
} from "../src/permission-engine.ts";
import type { PermissionRule } from "../src/permission-types.ts";

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

describe("classifyOperation", () => {
  test("classifies readFile as file.read", () => {
    expect(classifyOperation(makeRequest("readFile"))).toBe("file.read");
  });

  test("classifies writeFile as file.write", () => {
    expect(classifyOperation(makeRequest("writeFile"))).toBe("file.write");
  });

  test("classifies editFile as file.write", () => {
    expect(classifyOperation(makeRequest("editFile"))).toBe("file.write");
  });

  test("classifies terminal as terminal.create", () => {
    expect(classifyOperation(makeRequest("terminal"))).toBe("terminal.create");
  });

  test("classifies exec as terminal.create", () => {
    expect(classifyOperation(makeRequest("execCommand"))).toBe("terminal.create");
  });

  test("classifies deleteFile as file.delete", () => {
    expect(classifyOperation(makeRequest("deleteFile"))).toBe("file.delete");
  });

  test("classifies removeFile as file.delete", () => {
    expect(classifyOperation(makeRequest("removeFile"))).toBe("file.delete");
  });

  test("classifies unknown tools as tool.<name>", () => {
    expect(classifyOperation(makeRequest("fooBar"))).toBe("tool.foobar");
  });

  // Workspace-specific operation classifications
  test("classifies workspace.search as workspace.search", () => {
    expect(classifyOperation(makeRequest("workspace.search"))).toBe("workspace.search");
  });

  test("classifies workspace_search as workspace.search", () => {
    expect(classifyOperation(makeRequest("workspace_search"))).toBe("workspace.search");
  });

  test("classifies workspace.command.execute as workspace.command.execute", () => {
    expect(classifyOperation(makeRequest("workspace.command.execute"))).toBe(
      "workspace.command.execute",
    );
  });

  test("classifies workspace_command_execute as workspace.command.execute", () => {
    expect(classifyOperation(makeRequest("workspace_command_execute"))).toBe(
      "workspace.command.execute",
    );
  });

  test("classifies workspace.command.list as workspace.command.list", () => {
    expect(classifyOperation(makeRequest("workspace.command.list"))).toBe("workspace.command.list");
  });

  test("classifies workspace.data-query as workspace.data-query", () => {
    expect(classifyOperation(makeRequest("workspace.data-query"))).toBe("workspace.data-query");
  });

  test("classifies workspace.navigate as workspace.navigate", () => {
    expect(classifyOperation(makeRequest("workspace.navigate"))).toBe("workspace.navigate");
  });

  test("edit check takes precedence over command for ambiguous tool names", () => {
    // When a tool name contains both "edit" and "command", the edit pattern
    // matches first, classifying it as file.write rather than terminal.create.
    // This is the intended ordering: workspace.command patterns are checked first
    // (highest priority), then file operations, then terminal patterns.
    const result = classifyOperation(makeRequest("editCommandConfig"));
    expect(result).toBe("file.write");
  });

  test("workspace.command patterns take priority over edit classification", () => {
    const result = classifyOperation(makeRequest("workspace.command.execute"));
    expect(result).toBe("workspace.command.execute");
  });
});

describe("extractResourceScope", () => {
  test("extracts path argument", () => {
    expect(extractResourceScope(makeRequest("read", { path: "/ws/test.md" }))).toBe("/ws/test.md");
  });

  test("extracts file argument", () => {
    expect(extractResourceScope(makeRequest("read", { file: "/ws/a.md" }))).toBe("/ws/a.md");
  });

  test("extracts command as cmd: prefix", () => {
    expect(extractResourceScope(makeRequest("term", { command: "git" }))).toBe("cmd:git");
  });

  test("returns * when no recognizable args", () => {
    expect(extractResourceScope(makeRequest("something"))).toBe("*");
  });
});

describe("isHighRisk", () => {
  test("terminal.create is high-risk", () => {
    expect(isHighRisk("terminal.create", makeRequest("terminal"))).toBe(true);
  });

  test("terminal.shell is high-risk", () => {
    expect(isHighRisk("terminal.shell", makeRequest("terminal"))).toBe(true);
  });

  test("file.delete is high-risk", () => {
    expect(isHighRisk("file.delete", makeRequest("delete"))).toBe(true);
  });

  test("workspace.command.execute is high-risk", () => {
    expect(isHighRisk("workspace.command.execute", makeRequest("workspace.command.execute"))).toBe(
      true,
    );
  });

  test("file.read is not high-risk", () => {
    expect(isHighRisk("file.read", makeRequest("readFile"))).toBe(false);
  });

  test("terminal.create with shell command is high-risk", () => {
    expect(isHighRisk("terminal.create", makeRequest("terminal", { command: "bash" }))).toBe(true);
  });
});

describe("scopeMatches", () => {
  test("wildcard matches everything", () => {
    expect(scopeMatches("*", "/ws/test.md")).toBe(true);
  });

  test("exact match", () => {
    expect(scopeMatches("/ws/test.md", "/ws/test.md")).toBe(true);
  });

  test("no match for different paths", () => {
    expect(scopeMatches("/ws/a.md", "/ws/b.md")).toBe(false);
  });

  test("directory prefix match", () => {
    expect(scopeMatches("/ws/dir/", "/ws/dir/file.md")).toBe(true);
  });

  test("no match for shared prefix without trailing slash", () => {
    expect(scopeMatches("/ws/dir", "/ws/dir-other/file.md")).toBe(false);
  });
});

describe("evaluatePermissionRules", () => {
  test("returns no match when no rules exist", () => {
    const { match } = evaluatePermissionRules(
      makeRequest("readFile", { path: "/ws/test.md" }),
      "test-agent",
      "/ws",
      [],
    );
    expect(match.matched).toBe(false);
  });

  test("matches a rule by agent, workspace, operation, and scope", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "/ws", "allow", "session", "allow");

    const { match } = evaluatePermissionRules(request, "test-agent", "/ws", [rule]);
    expect(match.matched).toBe(true);
    expect(match.rule?.outcome).toBe("allow");
  });

  test("does not match when agent name differs", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "agent-a", "/ws", "allow", "session", "allow");

    const { match } = evaluatePermissionRules(request, "agent-b", "/ws", [rule]);
    expect(match.matched).toBe(false);
  });

  test("does not match when workspace differs", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "/ws-a", "allow", "session", "allow");

    const { match } = evaluatePermissionRules(request, "test-agent", "/ws-b", [rule]);
    expect(match.matched).toBe(false);
  });

  test("matches wildcard workspace rules across workspaces", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "*", "allow", "session", "allow");

    const { match } = evaluatePermissionRules(request, "test-agent", "/ws-b", [rule]);
    expect(match.matched).toBe(true);
  });

  test('matches legacy "global" workspace rules across workspaces', () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "global", "allow", "session", "allow");

    const { match } = evaluatePermissionRules(request, "test-agent", "/ws-b", [rule]);
    expect(match.matched).toBe(true);
  });

  test("high-risk: terminal.create operations never match", () => {
    const request = makeRequest("terminal", { command: "git" });
    const rule = createPermissionRule(request, "test-agent", "/ws", "allow", "session", "allow");

    const { match } = evaluatePermissionRules(request, "test-agent", "/ws", [rule]);
    expect(match.matched).toBe(false);
    expect(match.reason).toContain("High-risk");
  });

  test("high-risk: shell commands never match", () => {
    const { match } = evaluatePermissionRules(
      makeRequest("terminal", { command: "bash" }),
      "test-agent",
      "/ws",
      [],
    );
    expect(match.matched).toBe(false);
    expect(match.reason).toContain("High-risk");
  });

  test("high-risk: powershell never matches", () => {
    const { match } = evaluatePermissionRules(
      makeRequest("exec", { command: "powershell" }),
      "test-agent",
      "/ws",
      [],
    );
    expect(match.matched).toBe(false);
    expect(match.reason).toContain("High-risk");
  });

  test("high-risk requests still remove expired rules from updatedRules", () => {
    const expiredRule = createPermissionRule(
      makeRequest("readFile", { path: "/ws/test.md" }),
      "test-agent",
      "/ws",
      "allow",
      "session",
      "allow",
    );
    expiredRule.expiresAt = Date.now() - 1000;

    const { match, updatedRules } = evaluatePermissionRules(
      makeRequest("terminal", { command: "bash" }),
      "test-agent",
      "/ws",
      [expiredRule],
    );

    expect(match.matched).toBe(false);
    expect(updatedRules).toHaveLength(0);
  });

  test("match.rule is a separate copy from updatedRules entries", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "/ws", "allow", "session", "allow");

    const { match, updatedRules } = evaluatePermissionRules(request, "test-agent", "/ws", [rule]);
    expect(match.matched).toBe(true);
    // Mutating match.rule should not affect updatedRules
    if (!match.rule) {
      throw new Error("expected match rule");
    }
    match.rule.agentName = "MUTATED";
    expect(updatedRules[0]?.agentName).toBe("test-agent");
  });

  test("expired rules are filtered out", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "/ws", "allow", "session", "allow");
    rule.expiresAt = Date.now() - 1000;

    const { match, updatedRules } = evaluatePermissionRules(request, "test-agent", "/ws", [rule]);
    expect(match.matched).toBe(false);
    expect(updatedRules.length).toBe(0);
  });

  test("non-expired rules are preserved", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "/ws", "allow", "session", "allow");
    rule.expiresAt = Date.now() + 60000;

    const { match } = evaluatePermissionRules(request, "test-agent", "/ws", [rule]);
    expect(match.matched).toBe(true);
  });

  test("wildcard resource scope matches everything", () => {
    const request1 = makeRequest("readFile");
    const rule = createPermissionRule(request1, "test-agent", "/ws", "allow", "session", "allow");

    const request2 = makeRequest("readFile", { path: "/ws/foo.md" });
    const { match } = evaluatePermissionRules(request2, "test-agent", "/ws", [rule]);
    expect(match.matched).toBe(true);
  });

  test("marks once-rules as consumed and filters them from updatedRules", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "/ws", "allow", "once", "allow");

    const { match, updatedRules } = evaluatePermissionRules(request, "test-agent", "/ws", [rule]);
    expect(match.matched).toBe(true);
    expect(match.rule?.consumed).toBe(true);
    // Consumed once-rules are filtered from updatedRules
    expect(updatedRules.length).toBe(0);
  });

  test("does not mutate input rules array", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "/ws", "allow", "once", "allow");
    const originalRules = [rule];

    evaluatePermissionRules(request, "test-agent", "/ws", originalRules);
    expect(originalRules[0]?.consumed).toBeUndefined();
  });

  test("does not auto-match allow rules when remembered option is missing", () => {
    const request = makeRequest("readFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "/ws", "allow", "persistent", "allow");

    const differentOptionRequest = {
      ...request,
      options: [{ optionId: "different", name: "Different", kind: "allow_once" as const }],
    };

    const { match } = evaluatePermissionRules(differentOptionRequest, "test-agent", "/ws", [rule]);
    expect(match.matched).toBe(false);
  });

  test("matches reject rules without requiring an option id", () => {
    const request = makeRequest("writeFile", { path: "/ws/test.md" });
    const rule = createPermissionRule(request, "test-agent", "/ws", "reject", "persistent");

    const { match } = evaluatePermissionRules(request, "test-agent", "/ws", [rule]);
    expect(match.matched).toBe(true);
    expect(match.rule?.outcome).toBe("reject");
  });
});

describe("createPermissionRule", () => {
  test("classifies file operations correctly", () => {
    const rule = createPermissionRule(
      makeRequest("writeFile", { path: "/ws/test.md" }),
      "a",
      "/ws",
      "allow",
      "session",
      "allow",
    );
    expect(rule.operationClass).toBe("file.write");
  });

  test("classifies terminal operations correctly", () => {
    const rule = createPermissionRule(
      makeRequest("createTerminal", { command: "git" }),
      "a",
      "/ws",
      "allow",
      "session",
      "allow",
    );
    expect(rule.operationClass).toBe("terminal.create");
  });

  test("generates unique rule ids", () => {
    const request = makeRequest("readFile");
    const rule1 = createPermissionRule(request, "a", "/ws", "allow", "session", "allow");
    const rule2 = createPermissionRule(request, "a", "/ws", "allow", "session", "allow");
    expect(rule1.id).not.toBe(rule2.id);
  });

  test("uses scopeOverride when provided", () => {
    const rule = createPermissionRule(
      makeRequest("writeFile", { path: "/ws/original.md" }),
      "a",
      "/ws",
      "allow",
      "session",
      "allow",
      "/ws/overridden/",
    );
    expect(rule.resourceScope).toBe("/ws/overridden/");
  });

  test("uses extracted scope when scopeOverride is undefined", () => {
    const rule = createPermissionRule(
      makeRequest("writeFile", { path: "/ws/test.md" }),
      "a",
      "/ws",
      "allow",
      "session",
      "allow",
      undefined,
    );
    expect(rule.resourceScope).toBe("/ws/test.md");
  });
});

describe("createRememberedRule", () => {
  test("returns null for once lifetime", () => {
    const rule = createRememberedRule(
      makeRequest("readFile", { path: "/ws/test.md" }),
      { outcome: { outcome: "selected", optionId: "allow" } },
      "once",
      "test-agent",
      "/ws",
    );
    expect(rule).toBeNull();
  });

  test("creates allow rule for selected response", () => {
    const rule = createRememberedRule(
      makeRequest("readFile", { path: "/ws/test.md" }),
      { outcome: { outcome: "selected", optionId: "allow" } },
      "session",
      "test-agent",
      "/ws",
    );
    expect(rule).not.toBeNull();
    expect(rule?.outcome).toBe("allow");
    expect(rule?.selectedOptionId).toBe("allow");
    expect(rule?.lifetime).toBe("session");
  });

  test("creates reject rule for cancelled response", () => {
    const rule = createRememberedRule(
      makeRequest("writeFile", { path: "/ws/test.md" }),
      { outcome: { outcome: "cancelled" } },
      "persistent",
      "test-agent",
      "/ws",
    );
    expect(rule).not.toBeNull();
    expect(rule?.outcome).toBe("reject");
    expect(rule?.lifetime).toBe("persistent");
    expect(rule?.selectedOptionId).toBeUndefined();
  });

  test("uses scopeOverride when provided", () => {
    const rule = createRememberedRule(
      makeRequest("readFile", { path: "/ws/original.md" }),
      { outcome: { outcome: "selected", optionId: "allow" } },
      "session",
      "test-agent",
      "/ws",
      "/ws/custom-scope/",
    );
    expect(rule).not.toBeNull();
    expect(rule?.resourceScope).toBe("/ws/custom-scope/");
  });

  test("uses extracted scope when scopeOverride is undefined", () => {
    const rule = createRememberedRule(
      makeRequest("readFile", { path: "/ws/test.md" }),
      { outcome: { outcome: "selected", optionId: "allow" } },
      "session",
      "test-agent",
      "/ws",
      undefined,
    );
    expect(rule).not.toBeNull();
    expect(rule?.resourceScope).toBe("/ws/test.md");
  });
});

describe("rule filtering helpers", () => {
  function makeRule(overrides: Partial<PermissionRule>): PermissionRule {
    return {
      id: `rule-${Math.random()}`,
      agentName: "test",
      workspacePath: "/ws",
      operationClass: "file.read",
      resourceScope: "*",
      lifetime: "session",
      outcome: "allow",
      selectedOptionId: "allow",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      expiresAt: null,
      creationSource: "user_prompt",
      ...overrides,
    };
  }

  test("filterSessionRules keeps only persistent rules", () => {
    const rules = [
      makeRule({ lifetime: "session" }),
      makeRule({ lifetime: "persistent" }),
      makeRule({ lifetime: "once" }),
    ];
    const filtered = filterSessionRules(rules);
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.lifetime).toBe("persistent");
  });

  test("filterConsumedOnceRules removes consumed once-rules", () => {
    const rules = [
      makeRule({ lifetime: "once", consumed: true }),
      makeRule({ lifetime: "once", consumed: false }),
      makeRule({ lifetime: "session" }),
    ];
    const filtered = filterConsumedOnceRules(rules);
    expect(filtered.length).toBe(2);
  });

  test("filterExpiredRules removes expired rules", () => {
    const rules = [
      makeRule({ expiresAt: Date.now() - 1000 }),
      makeRule({ expiresAt: Date.now() + 60000 }),
      makeRule({ expiresAt: null }),
    ];
    const filtered = filterExpiredRules(rules);
    expect(filtered.length).toBe(2);
  });
});

describe("isReadOnly", () => {
  test("file.read is read-only", () => {
    expect(isReadOnly("file.read")).toBe(true);
  });
  test("workspace.search is read-only", () => {
    expect(isReadOnly("workspace.search")).toBe(true);
  });
  test("workspace.command.list is read-only", () => {
    expect(isReadOnly("workspace.command.list")).toBe(true);
  });
  test("workspace.data-query is read-only", () => {
    expect(isReadOnly("workspace.data-query")).toBe(true);
  });
  test("workspace.navigate is read-only", () => {
    expect(isReadOnly("workspace.navigate")).toBe(true);
  });
  test("file.write is NOT read-only", () => {
    expect(isReadOnly("file.write")).toBe(false);
  });
  test("terminal.create is NOT read-only", () => {
    expect(isReadOnly("terminal.create")).toBe(false);
  });
  test("file.delete is NOT read-only", () => {
    expect(isReadOnly("file.delete")).toBe(false);
  });
  test("workspace.command.execute is NOT read-only", () => {
    expect(isReadOnly("workspace.command.execute")).toBe(false);
  });
  test("unknown tool class is NOT read-only", () => {
    expect(isReadOnly("tool.custom_thing")).toBe(false);
  });
});

describe("generateScopeCandidates", () => {
  const workspace = "/ws";

  test("path scope produces exact + parent + workspace + wildcard candidates", () => {
    const candidates = generateScopeCandidates("/ws/src/file.ts", workspace);
    const levels = candidates.map((c) => c.level);
    expect(levels).toContain("exact");
    expect(levels).toContain("parent_dir");
    expect(levels).toContain("workspace");
    expect(levels).toContain("wildcard");
    // Exact comes first, wildcard last
    expect(levels[0]).toBe("exact");
    expect(levels[levels.length - 1]).toBe("wildcard");
  });

  test("deeply nested path produces multiple ancestor candidates", () => {
    const candidates = generateScopeCandidates("/ws/a/b/c/d/file.ts", workspace);
    const levels = candidates.map((c) => c.level);
    // Should have: exact, parent_dir (d/), ancestor_dir (c/, b/, a/), workspace, wildcard
    const ancestorCount = levels.filter((l) => l === "ancestor_dir").length;
    expect(ancestorCount).toBeGreaterThanOrEqual(2);
    // Check ordering: parent_dir before ancestor_dir before workspace
    const parentIdx = levels.indexOf("parent_dir");
    const firstAncestorIdx = levels.indexOf("ancestor_dir");
    const workspaceIdx = levels.indexOf("workspace");
    expect(parentIdx).toBeLessThan(firstAncestorIdx);
    expect(firstAncestorIdx).toBeLessThan(workspaceIdx);
  });

  test("command scope produces exact command + wildcard", () => {
    const candidates = generateScopeCandidates("cmd:ls", workspace);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toEqual({
      level: "exact",
      scope: "cmd:ls",
      label: "Just this command: ls",
    });
    expect(candidates[1]).toEqual({
      level: "wildcard",
      scope: "*",
      label: "Any file or command",
    });
  });

  test("wildcard scope produces single wildcard candidate", () => {
    const candidates = generateScopeCandidates("*", workspace);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toEqual({
      level: "wildcard",
      scope: "*",
      label: "Any file or command",
    });
  });

  test("path at workspace root produces exact + workspace + wildcard (no parent between them)", () => {
    const candidates = generateScopeCandidates("/ws/file.ts", workspace);
    const levels = candidates.map((c) => c.level);
    expect(levels).toEqual(["exact", "workspace", "wildcard"]);
    expect(candidates[0]?.scope).toBe("/ws/file.ts");
    expect(candidates[0]?.label).toBe("Just this file: file.ts");
    expect(candidates[1]?.scope).toBe("/ws/");
    expect(candidates[1]?.label).toBe("Entire workspace");
  });

  test("all candidates are deduplicated by scope string", () => {
    const candidates = generateScopeCandidates("/ws/src/file.ts", workspace);
    const scopes = candidates.map((c) => c.scope);
    const uniqueScopes = new Set(scopes);
    expect(scopes.length).toBe(uniqueScopes.size);
  });

  test("candidates are ordered from most specific to broadest", () => {
    const candidates = generateScopeCandidates("/ws/a/b/file.ts", workspace);
    const levels = candidates.map((c) => c.level);

    // Define expected ordering of levels
    const levelOrder: Record<string, number> = {
      exact: 0,
      parent_dir: 1,
      ancestor_dir: 2,
      workspace: 3,
      wildcard: 4,
    };

    for (let i = 1; i < levels.length; i++) {
      const prevOrder = levelOrder[levels[i - 1] as string] ?? 0;
      const currOrder = levelOrder[levels[i] as string] ?? 0;
      expect(currOrder).toBeGreaterThanOrEqual(prevOrder);
    }
  });

  test("directory-like path (no extension) labels as directory", () => {
    const candidates = generateScopeCandidates("/ws/src/project_alpha", "/ws");
    expect(candidates[0]?.label).toBe("Just this directory: project_alpha/");
    expect(candidates[0]?.scope).toBe("/ws/src/project_alpha");
  });

  test("path with trailing slash labels as directory", () => {
    const candidates = generateScopeCandidates("/ws/src/components/", "/ws");
    expect(candidates[0]?.label).toMatch(/^Just this directory:/);
  });

  test("dotfile (.env) labels as file", () => {
    const candidates = generateScopeCandidates("/ws/.env", "/ws");
    expect(candidates[0]?.label).toBe("Just this file: .env");
  });

  test("file with extension labels as file", () => {
    const candidates = generateScopeCandidates("/ws/src/index.ts", "/ws");
    expect(candidates[0]?.label).toBe("Just this file: index.ts");
  });

  test("nested directory path labels correctly", () => {
    const candidates = generateScopeCandidates("/ws/packages/policy", "/ws");
    expect(candidates[0]?.label).toBe("Just this directory: policy/");
  });
});
