/**
 * Learning tests for `agents-js generate-config` — the agent/profile generator
 * that EMITS the existing launch-config AgentEntry (no parallel schema) and
 * validates it through the exact launch-time chain.
 *
 * LT-1: minimal pi dual-window flags → a full config to stdout with defaults
 *       applied (tmux_session=name, binary=pi) and dual_window:true.
 * LT-2: defaults for a non-pi harness (codex): binary=codex, fresh_flags="".
 * LT-3: an entry that would NOT launch (dual_window on codex) is REFUSED —
 *       non-zero exit, nothing emitted to stdout. The generator reuses the
 *       real `buildLaunchPlan` gate, not a re-implemented one.
 * LT-4: the emitted entry round-trips through resolveAgentEntry + buildLaunchPlan
 *       (parity with the launch/onboard path).
 * LT-5: --merge preserves the existing agents + top-level fields and inserts the
 *       new entry; a MATRIX_AGENT collision is refused and never written.
 * LT-6: a declared provider with NO real cred in the env still generates —
 *       generation validates SHAPE, not secret presence.
 * LT-7: a missing required flag is a usage error with nothing emitted.
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
describe("generate-config — LT-1 minimal pi dual-window", () => {
  test("emits a full config with defaults + dual_window", async () => {
    const { stdout, dependencies } = deps();
    const code = await runGenerateConfigCommand(
      ["--name", "demo-pi", "--harness", "pi", "--workspace", "/work", "--dual-window"],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(stdout.text);
    expect(parsed.version).toBe("0.1.0");
    const entry = parsed.agents["demo-pi"];
    expect(entry.tmux_session).toBe("demo-pi"); // defaults to --name
    expect(entry.binary).toBe("pi"); // harness native binary
    expect(entry.harness).toBe("pi");
    expect(entry.workspace).toBe("/work");
    expect(entry.fresh_flags).toBe("");
    expect(entry.dual_window).toBe(true);
  });
});

// LT-2 ----------------------------------------------------------------------
describe("generate-config — LT-2 defaults for codex", () => {
  test("binary defaults to codex; tmux_session to name; fresh_flags empty", async () => {
    const { stdout, dependencies } = deps();
    const code = await runGenerateConfigCommand(
      ["--name", "demo-cx", "--harness", "codex", "--workspace", "/work"],
      dependencies,
    );
    expect(code).toBe(EXIT_OK);
    const entry = JSON.parse(stdout.text).agents["demo-cx"];
    expect(entry.binary).toBe("codex");
    expect(entry.tmux_session).toBe("demo-cx");
    expect(entry.fresh_flags).toBe("");
    expect(entry.dual_window).toBeUndefined();
  });
});

// LT-3 ----------------------------------------------------------------------
describe("generate-config — LT-3 refuses an entry that would not launch", () => {
  test("dual_window on codex → non-zero exit, nothing on stdout", async () => {
    const { stdout, stderr, dependencies } = deps();
    const code = await runGenerateConfigCommand(
      ["--name", "bad", "--harness", "codex", "--workspace", "/work", "--dual-window"],
      dependencies,
    );
    expect(code).toBe(EXIT_ERROR);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("would not launch");
    expect(stderr.text).toContain('dual_window is only supported for the "pi" harness');
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
      ["--name", "p", "--harness", "pi", "--workspace", "/work", "--provider", "zai"],
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
  test("missing --workspace → usage error, nothing emitted", async () => {
    const { stdout, stderr, dependencies } = deps();
    const code = await runGenerateConfigCommand(["--name", "x", "--harness", "pi"], dependencies);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout.text).toBe("");
    expect(stderr.text).toContain("--workspace");
  });
});

// buildRawAgentEntry unit ---------------------------------------------------
describe("buildRawAgentEntry omits unset optional fields", () => {
  test("only specified fields appear", () => {
    const entry = buildRawAgentEntry({
      name: "a",
      harness: "pi",
      workspace: "/w",
      dualWindow: false,
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
      dualWindow: false,
    });
    expect(entry.env_setup).toBe("export MATRIX_AGENT=a-id");
  });
});
