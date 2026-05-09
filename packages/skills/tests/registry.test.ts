import { describe, expect, test } from "bun:test";
import path from "node:path";
import { InMemoryRegistry, loadSkill } from "../src/index.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const FIXTURES_ALT = path.join(import.meta.dir, "fixtures-alt");

describe("InMemoryRegistry", () => {
  test("add -> get round-trip preserves identity", () => {
    const skill = loadSkill("valid-skill", { searchPaths: [FIXTURES] });
    const reg = new InMemoryRegistry();
    reg.add(skill);
    const fetched = reg.get("valid-skill");
    expect(fetched).toBe(skill);
  });

  test("has() reflects membership without needing a lookup", () => {
    const reg = new InMemoryRegistry();
    expect(reg.has("valid-skill")).toBe(false);
    reg.add(loadSkill("valid-skill", { searchPaths: [FIXTURES] }));
    expect(reg.has("valid-skill")).toBe(true);
  });

  test("list() returns all entries sorted by name", () => {
    const reg = new InMemoryRegistry();
    reg.add(loadSkill("valid-skill", { searchPaths: [FIXTURES] }));
    reg.add(loadSkill("only-in-alt", { searchPaths: [FIXTURES_ALT] }));
    const names = reg.list().map((s) => s.name);
    expect(names).toEqual(["only-in-alt", "valid-skill"]);
  });

  test("add() replaces an existing entry with the same name", () => {
    const reg = new InMemoryRegistry();
    const first = loadSkill("valid-skill", { searchPaths: [FIXTURES] });
    const second = loadSkill("valid-skill", { searchPaths: [FIXTURES_ALT] });
    reg.add(first);
    reg.add(second);
    expect(reg.get("valid-skill")).toBe(second);
    expect(reg.size).toBe(1);
  });

  test("remove() removes an entry and returns whether it existed", () => {
    const reg = new InMemoryRegistry();
    reg.add(loadSkill("valid-skill", { searchPaths: [FIXTURES] }));
    expect(reg.remove("valid-skill")).toBe(true);
    expect(reg.remove("valid-skill")).toBe(false);
    expect(reg.has("valid-skill")).toBe(false);
  });

  test("clear() empties the registry", () => {
    const reg = new InMemoryRegistry();
    reg.add(loadSkill("valid-skill", { searchPaths: [FIXTURES] }));
    reg.add(loadSkill("only-in-alt", { searchPaths: [FIXTURES_ALT] }));
    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.list()).toEqual([]);
  });
});
