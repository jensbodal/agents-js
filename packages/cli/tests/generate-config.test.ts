/**
 * Learning tests for `agents-js generate-config` — the agent/profile generator
 * that EMITS the existing launch-config AgentEntry (no parallel schema) and
 * validates it through the exact launch-time chain.
 *
 * LT-1: minimal pi config → default update of the user config with inferred
 *       workspace, MATRIX_AGENT, cockpit, and `--approve`.
 * LT-2: defaults for a non-pi harness (codex): binary=codex, fresh_flags="".
 * LT-3: an entry that would NOT launch (cockpit on codex) is REFUSED —
 *       non-zero exit, nothing emitted to stdout. The generator reuses the
 *       real `buildLaunchPlan` gate, not a re-implemented one.
 * LT-4: the emitted entry round-trips through resolveAgentEntry + buildLaunchPlan
 *       (parity with the launch/onboard path).
 * LT-5: --merge preserves the existing agents + top-level fields and inserts the
 *       new entry; a MATRIX_AGENT collision is refused and never written.
 * LT-6: a declared provider with NO real cred in the env still generates —
 *       generation validates SHAPE, not secret presence.
 * LT-7: a missing required flag is a usage error with nothing emitted.
 * LT-9: --stdout/--print are print-only aliases and never write a config file.
 * LT-10: --config is update semantics for the named config path; --merge remains
 *        the back-compat spelling for the same operation.
 * LT-11: default update path follows launch-visible config env, so the minimal
 *        generate-config/onboard pair does not write one file and read another.
 */
import { describe, expect, test } from "bun:test";
import {
  buildLaunchPlan,
  type LaunchConfig,
  type LaunchEnv,
  parseLaunchConfig,
  resolveAgentEntry,
  resolveProviderCredEnvKeys,
} from "@agents-js/agent-launch";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "../src/exit-codes.ts";
import {
  buildRawAgentEntry,
  type GenerateConfigDependencies,
  runGenerateConfigCommand,
} from "../src/generate-config.ts";

function capture() {
  let text = "";
  return {
    write(chunk: string) {
      text += chunk;
      return true;
    },
    get text() {
      return text;
    },
  };
}

function deps(over: Partial<GenerateConfigDependencies> = {}): {
  stdout: ReturnType<typeof capture>;
  stderr: ReturnType<typeof capture>;
  dependencies: GenerateConfigDependencies;
} {
  const stdout = capture();
  const stderr = capture();
  return { stdout, stderr, dependencies: { stdout, stderr, ...over } };
}

// LT-1 ----------------------------------------------------------------------
describe("generate-config — LT-1 default update for minimal pi onboarding", () => {
  test("writes the user config with inferred identity-workspace defaults", async () => {
    let loadedPath: string | undefined;
    let written: { path: string; text: string } | undefined;
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const { stdout, stderr, dependencies } = deps({
      home: "/home/test",
      loadConfig: async (path) => {
        loadedPath = path;
        throw missing;
      },
      writeConfig: async (path, text) => {
        written = { path, text };
      },
    });
    const code = await runGenerateConfigCommand(
      ["--name", "olthoi0-pi-jensbodal", "--harness", "pi"],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);
    expect(stdout.text).toBe("");
    expect(loadedPath).toBe("/home/test/.config/agents-js/agent-launch-config.json");
    expect(written?.path).toBe("/home/test/.config/agents-js/agent-launch-config.json");
    const parsed = JSON.parse(written?.text ?? "{}");
    expect(parsed.version).toBe("0.1.0");
    const entry = parsed.agents["olthoi0-pi-jensbodal"];
    expect(entry.tmux_session).toBe("olthoi0-pi-jensbodal"); // defaults to --name
    expect(entry.binary).toBe("pi"); // harness native binary
    expect(entry.harness).toBe("pi");
    expect(entry.workspace).toBe("/home/test/workspaces/agents/olthoi0-pi-jensbodal");
    expect(entry.env_setup).toBe("export MATRIX_AGENT=olthoi0-pi-jensbodal");
    expect(entry.fresh_flags).toBe("--approve");
    expect(entry.cockpit).toBe(true);
    expect(stderr.text).toContain("agents-js onboard olthoi0-pi-jensbodal");
  });
});

// LT-2 ----------------------------------------------------------------------
describe("generate-config — LT-2 defaults for codex", () => {
  test("binary defaults to codex; tmux_session to name; fresh_flags empty", async () => {
    const { stdout, dependencies } = deps();
    const code = await runGenerateConfigCommand(
      ["--name", "demo-cx", "--harness", "codex", "--workspace", "/work", "--stdout"],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);
    const entry = JSON.parse(stdout.text).agents["demo-cx"];
    expect(entry.binary).toBe("codex");
    expect(entry.tmux_session).toBe("demo-cx");
    expect(entry.fresh_flags).toBe("");
    expect(entry.cockpit).toBeUndefined();
  });
});

// LT-3 ----------------------------------------------------------------------
describe("generate-config — LT-3 refuses an entry that would not launch", () => {
  test("cockpit on codex → non-zero exit, nothing on stdout", async () => {
    const { stdout, stderr, dependencies } = deps();
    const code = await runGenerateConfigCommand(
      ["--name", "bad", "--harness", "codex", "--workspace", "/work", "--cockpit", "--stdout"],
      dependencies,
    );
    expect(code).toBe(EXIT_ERROR);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("would not launch");
    expect(stderr.text).toContain('cockpit is only supported for the "pi" harness');
  });
});

// LT-4 ----------------------------------------------------------------------
describe("generate-config — LT-4 emitted entry round-trips through the launch path", () => {
  test("stdout config resolves + builds a plan identically", async () => {
    const { stdout, dependencies } = deps();
    const code = await runGenerateConfigCommand(
      [
        "--name",
        "rt",
        "--harness",
        "pi",
        "--workspace",
        "/work",
        "--provider",
        "zai",
        "--pi-port",
        "3101",
        "--stdout",
      ],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);

    // Feed the emitted JSON back through the EXACT chain launch/onboard use.
    const config = parseLaunchConfig(stdout.text, "<roundtrip>");
    const entry = resolveAgentEntry(config, "rt");
    const placeholderEnv: Record<string, string> = {};
    for (const k of resolveProviderCredEnvKeys(entry.provider)) {
      placeholderEnv[k] = "x";
    }
    const plan = buildLaunchPlan(entry, { baseEnv: placeholderEnv as LaunchEnv });
    expect(plan.harness).toBe("pi");
    expect(entry.piPort).toBe("3101");
    expect(entry.provider).toBe("zai");
  });
});

// LT-5 ----------------------------------------------------------------------
describe("generate-config — LT-5 --merge", () => {
  const existingConfig: LaunchConfig = parseLaunchConfig(
    JSON.stringify({
      version: "0.2.0",
      description: "fleet",
      agents: {
        keep: {
          tmux_session: "keep",
          harness: "pi",
          binary: "pi",
          workspace: "/keep",
          fresh_flags: "",
          env_setup: "export MATRIX_AGENT=keep-id",
        },
      },
    }),
    "<existing>",
  );

  test("inserts the new entry and preserves existing agents + version", async () => {
    let written: { path: string; text: string } | undefined;
    const { stderr, dependencies } = deps({
      loadConfig: async () => existingConfig,
      writeConfig: async (path, text) => {
        written = { path, text };
      },
    });
    const code = await runGenerateConfigCommand(
      ["--name", "added", "--harness", "codex", "--workspace", "/new", "--merge", "/cfg.json"],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);
    expect(written?.path).toBe("/cfg.json");
    const out = JSON.parse(written?.text ?? "{}");
    expect(out.version).toBe("0.2.0"); // preserved
    expect(out.description).toBe("fleet"); // preserved
    expect(Object.keys(out.agents).sort()).toEqual(["added", "keep"]);
    expect(out.agents.added.binary).toBe("codex");
    expect(stderr.text).toContain("agents-js onboard added --config /cfg.json");
  });

  test("MATRIX_AGENT collision is refused and never written", async () => {
    let wrote = false;
    const { stdout, stderr, dependencies } = deps({
      loadConfig: async () => existingConfig,
      writeConfig: async () => {
        wrote = true;
      },
    });
    const code = await runGenerateConfigCommand(
      [
        "--name",
        "clash",
        "--harness",
        "pi",
        "--workspace",
        "/new",
        "--matrix-agent",
        "keep-id", // collides with the existing `keep` entry
        "--merge",
        "/cfg.json",
      ],
      dependencies,
    );
    expect(code).toBe(EXIT_ERROR);
    expect(wrote).toBe(false);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("MATRIX_AGENT");
  });
});

// LT-6 ----------------------------------------------------------------------
describe("generate-config — LT-6 provider without a real secret still generates", () => {
  test("validates shape, not secret presence", async () => {
    const { stdout, dependencies } = deps();
    const code = await runGenerateConfigCommand(
      ["--name", "p", "--harness", "pi", "--workspace", "/work", "--provider", "zai", "--stdout"],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);
    const entry = JSON.parse(stdout.text).agents.p;
    expect(entry.provider).toBe("zai");
    // The real ZAI_API_KEY is never read or emitted.
    expect(stdout.text).not.toContain("ZAI_API_KEY");
  });
});

// LT-7 ----------------------------------------------------------------------
describe("generate-config — LT-7 missing required flag", () => {
  test("missing --harness → usage error, nothing emitted", async () => {
    const { stdout, stderr, dependencies } = deps();
    const code = await runGenerateConfigCommand(["--name", "x"], dependencies);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("--harness");
  });
});

// LT-9 ----------------------------------------------------------------------
describe("generate-config — LT-9 print-only aliases", () => {
  for (const flag of ["--stdout", "--print"]) {
    test(`${flag} emits JSON and never reads or writes the default config`, async () => {
      const { stdout, dependencies } = deps({
        home: "/home/test",
        loadConfig: async () => {
          throw new Error("print mode must not read");
        },
        writeConfig: async () => {
          throw new Error("print mode must not write");
        },
      });
      const code = await runGenerateConfigCommand(
        ["--name", "demo-pi", "--harness", "pi", flag],
        dependencies,
      );
      expect(code).toBe(EXIT_OK);
      const entry = JSON.parse(stdout.text).agents["demo-pi"];
      expect(entry.workspace).toBe("/home/test/workspaces/agents/demo-pi");
      expect(entry.env_setup).toBe("export MATRIX_AGENT=demo-pi");
      expect(entry.fresh_flags).toBe("--approve");
      expect(entry.cockpit).toBe(true);
    });
  }
});

// LT-10 ---------------------------------------------------------------------
describe("generate-config — LT-10 explicit update paths", () => {
  const existingConfig: LaunchConfig = parseLaunchConfig(
    JSON.stringify({
      version: "0.2.0",
      agents: {
        keep: {
          tmux_session: "keep",
          harness: "pi",
          binary: "pi",
          workspace: "/keep",
          fresh_flags: "",
        },
      },
    }),
    "<existing>",
  );

  test("--config updates the named config path", async () => {
    let written: { path: string; text: string } | undefined;
    const { stdout, stderr, dependencies } = deps({
      loadConfig: async () => existingConfig,
      writeConfig: async (path, text) => {
        written = { path, text };
      },
    });
    const code = await runGenerateConfigCommand(
      ["--name", "added", "--harness", "pi", "--config", "/custom/agents.json"],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);
    expect(stdout.text).toBe("");
    expect(written?.path).toBe("/custom/agents.json");
    const out = JSON.parse(written?.text ?? "{}");
    expect(Object.keys(out.agents).sort()).toEqual(["added", "keep"]);
    expect(stderr.text).toContain("agents-js onboard added --config /custom/agents.json");
  });

  test("explicit workspace, matrix-agent, and fresh flags override inferred pi defaults", async () => {
    const { stdout, dependencies } = deps();
    const code = await runGenerateConfigCommand(
      [
        "--name",
        "override-pi",
        "--harness",
        "pi",
        "--workspace",
        "/custom/ws",
        "--matrix-agent",
        "custom-agent",
        "--fresh-flags",
        "--model zai",
        "--stdout",
      ],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);
    const entry = JSON.parse(stdout.text).agents["override-pi"];
    expect(entry.workspace).toBe("/custom/ws");
    expect(entry.env_setup).toBe("export MATRIX_AGENT=custom-agent");
    expect(entry.fresh_flags).toBe("--model zai");
  });
});

// LT-11 ---------------------------------------------------------------------
describe("generate-config — LT-11 launch-visible default config path", () => {
  test("AGENTS_JS_LAUNCH_CONFIG wins for default updates", async () => {
    let written: { path: string; text: string } | undefined;
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const { dependencies } = deps({
      env: { AGENTS_JS_LAUNCH_CONFIG: "/fleet/agent-launch-config.json" },
      loadConfig: async () => {
        throw missing;
      },
      writeConfig: async (path, text) => {
        written = { path, text };
      },
    });

    const code = await runGenerateConfigCommand(
      ["--name", "demo-pi", "--harness", "pi"],
      dependencies,
    );

    expect(code).toBe(EXIT_OK);
    expect(written?.path).toBe("/fleet/agent-launch-config.json");
  });

  test("XDG_CONFIG_HOME wins over ~/.config for default updates when launch will read XDG first", async () => {
    let written: { path: string; text: string } | undefined;
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const { dependencies } = deps({
      home: "/home/test",
      env: { XDG_CONFIG_HOME: "/xdg" },
      loadConfig: async () => {
        throw missing;
      },
      writeConfig: async (path, text) => {
        written = { path, text };
      },
    });

    const code = await runGenerateConfigCommand(
      ["--name", "demo-pi", "--harness", "pi"],
      dependencies,
    );

    expect(code).toBe(EXIT_OK);
    expect(written?.path).toBe("/xdg/agents-js/agent-launch-config.json");
  });
});

// buildRawAgentEntry unit ---------------------------------------------------
describe("buildRawAgentEntry omits unset optional fields", () => {
  test("only specified fields appear", () => {
    const entry = buildRawAgentEntry({
      name: "a",
      harness: "pi",
      workspace: "/w",
      cockpit: false,
    });
    expect(entry).toEqual({
      tmux_session: "a",
      harness: "pi",
      binary: "pi",
      workspace: "/w",
      fresh_flags: "",
    });
    expect("provider" in entry).toBe(false);
    expect("env_setup" in entry).toBe(false);
  });

  test("matrix-agent becomes an env_setup export", () => {
    const entry = buildRawAgentEntry({
      name: "a",
      harness: "pi",
      workspace: "/w",
      matrixAgent: "a-id",
      cockpit: false,
    });
    expect(entry.env_setup).toBe("export MATRIX_AGENT=a-id");
  });
});

// LT-8 ----------------------------------------------------------------------
// Security regression (PR #182): the --matrix-agent value is interpolated
// verbatim into the env_setup shell string. A shell-unsafe value (`&&`,
// newline, `$`, `$(...)`, backtick, `;`) would smuggle a command into the
// composed launch command, so generation must REJECT it before it is embedded
// — non-zero exit, nothing on stdout — while a normal slug still succeeds.
describe("generate-config — LT-8 rejects shell-unsafe --matrix-agent", () => {
  const baseArgs = ["--name", "sec", "--harness", "pi", "--workspace", "/work"];

  const hostileValues: Array<[label: string, value: string]> = [
    ["command chaining with &&", "a && curl evil"],
    ["embedded newline", "a\ncurl evil"],
    ["bare $ variable expansion", "a$b"],
    ["command substitution $(...)", "$(curl evil)"],
    ["backtick command substitution", "`curl evil`"],
    ["semicolon command separator", "a;b"],
  ];

  for (const [label, value] of hostileValues) {
    test(`rejects ${label}`, async () => {
      const { stdout, stderr, dependencies } = deps();
      const code = await runGenerateConfigCommand(
        [...baseArgs, "--matrix-agent", value, "--stdout"],
        dependencies,
      );
      expect(code).toBe(EXIT_ERROR);
      // Nothing is emitted, so the hostile value never reaches a config file
      // or the composed launch command.
      expect(stdout.text).toBe("");
      expect(stderr.text).toContain("refusing to emit");
    });
  }

  test("a normal lowercase slug still generates and emits the export", async () => {
    const { stdout, dependencies } = deps();
    const code = await runGenerateConfigCommand(
      [...baseArgs, "--matrix-agent", "sec-agent_0", "--stdout"],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);
    const entry = JSON.parse(stdout.text).agents.sec;
    expect(entry.env_setup).toBe("export MATRIX_AGENT=sec-agent_0");
  });

  test("buildRawAgentEntry throws on a shell-unsafe slug before interpolation", () => {
    expect(() =>
      buildRawAgentEntry({
        name: "sec",
        harness: "pi",
        workspace: "/work",
        matrixAgent: "a && curl evil",
        cockpit: false,
      }),
    ).toThrow();
  });
});
