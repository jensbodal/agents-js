import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getAgentsJsConfigPaths,
  loadAgentsJsConfig,
  parseAgentsJsConfig,
} from "@agents-js/gateway-runtime";

async function withTempWorkspace(
  fn: (context: { cwd: string; homeDir: string; xdgConfigHome: string }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "agents-js-cli-config-"));
  const cwd = path.join(root, "workspace");
  const homeDir = path.join(root, "home");
  const xdgConfigHome = path.join(root, "xdg");

  await mkdir(cwd, { recursive: true });

  try {
    await fn({ cwd, homeDir, xdgConfigHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("agents-js config loading", () => {
  test("loads user config when no project override exists", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const paths = getAgentsJsConfigPaths({
        cwd,
        env: {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
      });

      await mkdir(path.dirname(paths.userConfigPath), { recursive: true });
      await writeFile(
        paths.userConfigPath,
        JSON.stringify({
          serve: {
            selectionPolicy: "prefer-saved",
            host: "127.0.0.1",
            port: 0,
            harness: {
              kind: "curated",
              runtime: "claude",
            },
          },
        }),
        "utf8",
      );

      const loaded = await loadAgentsJsConfig({
        cwd,
        env: {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
      });

      expect(loaded.effectiveConfig.serve?.harness).toEqual({
        kind: "curated",
        runtime: "claude",
      });
      expect(loaded.effectiveConfig.serve?.host).toBe("127.0.0.1");
    });
  });

  test("project config overrides user config", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const paths = getAgentsJsConfigPaths({
        cwd,
        env: {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
      });

      await mkdir(path.dirname(paths.userConfigPath), { recursive: true });
      await mkdir(path.dirname(paths.projectConfigPath), { recursive: true });
      await writeFile(
        paths.userConfigPath,
        JSON.stringify({
          serve: {
            selectionPolicy: "prefer-saved",
            host: "127.0.0.1",
            harness: {
              kind: "curated",
              runtime: "opencode",
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        paths.projectConfigPath,
        JSON.stringify({
          serve: {
            host: "0.0.0.0",
            harness: {
              kind: "curated",
              runtime: "claude",
            },
          },
        }),
        "utf8",
      );

      const loaded = await loadAgentsJsConfig({
        cwd,
        env: {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
      });

      expect(loaded.effectiveConfig.serve?.host).toBe("0.0.0.0");
      expect(loaded.effectiveConfig.serve?.harness).toEqual({
        kind: "curated",
        runtime: "claude",
      });
    });
  });

  test("loads and merges top-level runtime profiles with project replacement", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const paths = getAgentsJsConfigPaths({
        cwd,
        env: {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
      });

      await mkdir(path.dirname(paths.userConfigPath), { recursive: true });
      await mkdir(path.dirname(paths.projectConfigPath), { recursive: true });
      await writeFile(
        paths.userConfigPath,
        JSON.stringify({
          profiles: {
            "clean-room": {
              runtime: "opencode",
              env: {
                USER_ONLY: "1",
              },
            },
            claude_isolated: {
              runtime: "claude",
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        paths.projectConfigPath,
        JSON.stringify({
          profiles: {
            "clean-room": {
              runtime: "opencode",
              args: ["--isolated"],
            },
          },
        }),
        "utf8",
      );

      const loaded = await loadAgentsJsConfig({
        cwd,
        env: {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
      });

      expect(loaded.effectiveConfig.profiles).toEqual({
        "clean-room": {
          runtime: "opencode",
          args: ["--isolated"],
          env: { USER_ONLY: "1" },
        },
        claude_isolated: {
          runtime: "claude",
        },
      });
    });
  });

  test("user env key wins over project env key on conflict", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const paths = getAgentsJsConfigPaths({
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
      });

      await mkdir(path.dirname(paths.userConfigPath), { recursive: true });
      await mkdir(path.dirname(paths.projectConfigPath), { recursive: true });
      await writeFile(
        paths.userConfigPath,
        JSON.stringify({
          profiles: {
            "test-profile": {
              runtime: "opencode",
              env: { FOO: "user-value" },
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        paths.projectConfigPath,
        JSON.stringify({
          profiles: {
            "test-profile": {
              runtime: "opencode",
              env: { FOO: "project-value" },
            },
          },
        }),
        "utf8",
      );

      const loaded = await loadAgentsJsConfig({
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
      });

      expect(loaded.effectiveConfig.profiles?.["test-profile"]?.env?.FOO).toBe("user-value");
    });
  });

  test("project env key preserved when user has no env", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const paths = getAgentsJsConfigPaths({
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
      });

      await mkdir(path.dirname(paths.userConfigPath), { recursive: true });
      await mkdir(path.dirname(paths.projectConfigPath), { recursive: true });
      await writeFile(
        paths.userConfigPath,
        JSON.stringify({
          profiles: {
            "test-profile": {
              runtime: "opencode",
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        paths.projectConfigPath,
        JSON.stringify({
          profiles: {
            "test-profile": {
              runtime: "opencode",
              env: { BAR: "1" },
            },
          },
        }),
        "utf8",
      );

      const loaded = await loadAgentsJsConfig({
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
      });

      expect(loaded.effectiveConfig.profiles?.["test-profile"]?.env).toEqual({ BAR: "1" });
    });
  });

  test("user env key preserved when project has no env", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const paths = getAgentsJsConfigPaths({
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
      });

      await mkdir(path.dirname(paths.userConfigPath), { recursive: true });
      await mkdir(path.dirname(paths.projectConfigPath), { recursive: true });
      await writeFile(
        paths.userConfigPath,
        JSON.stringify({
          profiles: {
            "test-profile": {
              runtime: "claude",
              env: { BAZ: "1" },
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        paths.projectConfigPath,
        JSON.stringify({
          profiles: {
            "test-profile": {
              runtime: "opencode",
              args: ["--flag"],
            },
          },
        }),
        "utf8",
      );

      const loaded = await loadAgentsJsConfig({
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
      });

      const profile = loaded.effectiveConfig.profiles?.["test-profile"];
      expect(profile?.runtime).toBe("opencode");
      expect(profile?.args).toEqual(["--flag"]);
      expect(profile?.env).toEqual({ BAZ: "1" });
    });
  });

  test("user cannot override project runtime", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const paths = getAgentsJsConfigPaths({
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
      });

      await mkdir(path.dirname(paths.userConfigPath), { recursive: true });
      await mkdir(path.dirname(paths.projectConfigPath), { recursive: true });
      await writeFile(
        paths.userConfigPath,
        JSON.stringify({
          profiles: {
            "test-profile": {
              runtime: "claude",
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        paths.projectConfigPath,
        JSON.stringify({
          profiles: {
            "test-profile": {
              runtime: "opencode",
            },
          },
        }),
        "utf8",
      );

      const loaded = await loadAgentsJsConfig({
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
      });

      expect(loaded.effectiveConfig.profiles?.["test-profile"]?.runtime).toBe("opencode");
    });
  });

  test("parses curated harness profiles", () => {
    const config = parseAgentsJsConfig(
      {
        serve: {
          harness: {
            kind: "curated",
            runtime: "opencode",
            profile: "clean-room",
          },
        },
      },
      "/tmp/config.json",
    );

    expect(config.serve?.harness).toEqual({
      kind: "curated",
      runtime: "opencode",
      profile: "clean-room",
    });
  });

  test("rejects invalid runtime profile names", () => {
    expect(() =>
      parseAgentsJsConfig(
        {
          profiles: {
            "Bad Name": {
              runtime: "opencode",
            },
          },
        },
        "/tmp/config.json",
      ),
    ).toThrow('Profile names must contain only lowercase letters, numbers, "_" or "-".');
  });
});
