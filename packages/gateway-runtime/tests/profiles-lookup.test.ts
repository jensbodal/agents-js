import { describe, expect, test } from "bun:test";
import path from "node:path";
import { findConfiguredProfile } from "../src/profiles/lookup.ts";
import type { RuntimeProfile } from "../src/profiles/types.ts";

const userConfigPath = "/home/op/.config/agents-js/config.json";
const projectConfigPath = "/work/repo/.agents-js/config.json";

describe("findConfiguredProfile", () => {
  test("returns undefined when neither scope contains the profile", () => {
    expect(findConfiguredProfile("missing", { userConfigPath, projectConfigPath })).toBeUndefined();
  });

  test("returns user-scope profile when only user config has it", () => {
    const userProfile: RuntimeProfile = { runtime: "opencode" };
    const result = findConfiguredProfile("clean-room", {
      userConfigPath,
      projectConfigPath,
      userConfig: { profiles: { "clean-room": userProfile } },
    });

    expect(result?.profile).toBe(userProfile);
    expect(result?.source).toBe("user");
    expect(result?.profilesRoot).toBe(path.join(path.dirname(userConfigPath), "profiles"));
  });

  test("returns project-scope profile when only project config has it", () => {
    const projectProfile: RuntimeProfile = { runtime: "claude" };
    const result = findConfiguredProfile("clean-room", {
      userConfigPath,
      projectConfigPath,
      projectConfig: { profiles: { "clean-room": projectProfile } },
    });

    expect(result?.profile).toBe(projectProfile);
    expect(result?.source).toBe("project");
    expect(result?.profilesRoot).toBe(path.join(path.dirname(projectConfigPath), "profiles"));
  });

  test("project scope wins when both scopes define the profile", () => {
    const userProfile: RuntimeProfile = { runtime: "opencode" };
    const projectProfile: RuntimeProfile = { runtime: "claude" };
    const result = findConfiguredProfile("clean-room", {
      userConfigPath,
      projectConfigPath,
      userConfig: { profiles: { "clean-room": userProfile } },
      projectConfig: { profiles: { "clean-room": projectProfile } },
    });

    expect(result?.profile).toBe(projectProfile);
    expect(result?.source).toBe("project");
  });

  test("ignores configs that have no profiles map", () => {
    const result = findConfiguredProfile("clean-room", {
      userConfigPath,
      projectConfigPath,
      userConfig: {},
      projectConfig: {},
    });
    expect(result).toBeUndefined();
  });
});
