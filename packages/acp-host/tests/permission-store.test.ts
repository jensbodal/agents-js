import { describe, expect, test } from "bun:test";
import type { PermissionRule } from "@agents-js/policy/permission-types";
import { PermissionStore } from "../src/permission-store.ts";

function makeRule(
  id: string,
  lifetime: PermissionRule["lifetime"],
  outcome: PermissionRule["outcome"] = "allow",
): PermissionRule {
  const now = Date.now();
  return {
    id,
    agentName: "test-agent",
    workspacePath: "/workspace",
    operationClass: "file.read",
    resourceScope: "*",
    lifetime,
    outcome,
    selectedOptionId: outcome === "allow" ? "allow-1" : undefined,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: null,
    creationSource: "user_prompt",
    consumed: false,
  };
}

describe("PermissionStore", () => {
  test("init loads persisted rules", () => {
    const store = new PermissionStore();
    const persisted = [makeRule("persisted-1", "persistent")];

    store.init(persisted, async () => {});

    expect(store.getRules()).toEqual(persisted);
  });

  test("persists only persistent rules on add, remove, and clear", () => {
    const store = new PermissionStore();
    const saves: PermissionRule[][] = [];
    const sessionRule = makeRule("session-1", "session");
    const persistentRuleA = makeRule("persistent-1", "persistent");
    const persistentRuleB = makeRule("persistent-2", "persistent", "reject");

    store.init([], async (rules) => {
      saves.push(structuredClone(rules));
    });

    store.addRule(sessionRule);
    store.addRule(persistentRuleA);
    store.addRule(persistentRuleB);
    expect(store.removeRule(persistentRuleA.id)).toBe(true);
    store.clearAll();

    expect(saves).toEqual([
      [persistentRuleA],
      [persistentRuleA, persistentRuleB],
      [persistentRuleB],
      [],
    ]);
  });

  test("clearSessionRules keeps persistent rules without re-persisting unchanged data", () => {
    const store = new PermissionStore();
    const saves: PermissionRule[][] = [];
    const persistentRule = makeRule("persistent-1", "persistent");
    const sessionRule = makeRule("session-1", "session");
    const onceRule = makeRule("once-1", "once");

    store.init([], async (rules) => {
      saves.push(structuredClone(rules));
    });

    store.addRule(persistentRule);
    store.addRule(sessionRule);
    store.addRule(onceRule);
    store.clearSessionRules();

    expect(store.getRules()).toEqual([persistentRule]);
    expect(saves).toEqual([[persistentRule]]);
  });

  test("getPersistentRules filters out non-persistent rules", () => {
    const store = new PermissionStore();
    const persistentRule = makeRule("persistent-1", "persistent");
    const sessionRule = makeRule("session-1", "session");
    const onceRule = makeRule("once-1", "once");

    store.init([persistentRule, sessionRule, onceRule], async () => {});

    expect(store.getPersistentRules()).toEqual([persistentRule]);
  });

  test("persistRules triggers save callback", () => {
    const store = new PermissionStore();
    const saves: PermissionRule[][] = [];
    const persistentRule = makeRule("persistent-1", "persistent");

    store.init([persistentRule], async (rules) => {
      saves.push(structuredClone(rules));
    });

    store.persistRules();
    expect(saves.length).toBe(1);
    expect(saves[0]).toEqual([persistentRule]);
  });
});
