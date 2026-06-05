/**
 * `agents-js mcp` surfaces skills from a skills source (AGENTS_JS_SKILLS_DIR)
 * into the bridge's tool_search — the skills-as-MCP half of the seam. A native
 * pi (pi-extension spawns `agents-js mcp` in bridge mode) discovers provisioned
 * skills like grill-me this way.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBridgeConfig } from "../src/mcp.ts";

function makeSkillsSource(): string {
  const from = mkdtempSync(path.join(tmpdir(), "ajs-mcp-skills-"));
  const dir = path.join(from, ".claude", "skills", "grill-me");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "SKILL.md"),
    "---\nname: grill-me\ndescription: Interview relentlessly about a plan.\n---\n\nBody.\n",
  );
  return from;
}

describe("agents-js mcp — skills surface", () => {
  test("AGENTS_JS_SKILLS_DIR surfaces skills into the bridge config", async () => {
    const from = makeSkillsSource();
    const config = await loadBridgeConfig({
      AGENTS_JS_BRIDGE_AGENTS: "[]",
      AGENTS_JS_SKILLS_DIR: from,
    } as NodeJS.ProcessEnv);
    expect(config.agents).toEqual([]);
    expect(config.skills?.map((s) => s.name)).toContain("grill-me");
  });

  test("no skills key when AGENTS_JS_SKILLS_DIR is unset", async () => {
    const config = await loadBridgeConfig({
      AGENTS_JS_BRIDGE_AGENTS: "[]",
    } as NodeJS.ProcessEnv);
    expect(config.skills).toBeUndefined();
  });
});
