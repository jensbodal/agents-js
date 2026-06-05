import { cpSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkill, resolveSkillDir, SkillLoadError } from "@agents-js/skills";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";

const SKILL_RELATIVE_PATH = path.join("skills", "agents-js", "SKILL.md");

export interface SkillCommandDependencies {
  output?: Pick<NodeJS.WriteStream, "write">;
  moduleUrl?: string;
  readFile?: (filePath: string) => Promise<string>;
}

function printSkillHelp(output: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  output.write(
    `${[
      "Usage:",
      "  agents-js skill                       Print the agents-js SKILL.md to stdout",
      "  agents-js skill install <name> --from <dir>   Install a skill into a harness skills dir",
      "",
      "Print the installable agents-js SKILL.md document to stdout.",
      "",
      "Examples:",
      "  agents-js skill > ~/.codex/skills/agents-js/SKILL.md",
      "  agents-js skill install grill-me --from ~/workspace/skills-js",
      "",
      "Options:",
      "  --help, -h  Show this message",
    ].join("\n")}\n`,
  );
}

function printSkillInstallHelp(output: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  output.write(
    `${[
      "Usage:",
      "  agents-js skill install <skill-name> --from <skills-source-dir> [--into <dir>]",
      "",
      "Install a skill from a skills source (e.g. a skills-js checkout) into a",
      "harness skills directory. The source is resolved via @agents-js/skills",
      "(searching .claude/skills, skills/, then the dir itself); the matching",
      "skill directory is validated and copied to <into>/<skill-name>.",
      "",
      "Options:",
      "  --from <dir>   Skills source directory (required). e.g. a skills-js checkout",
      "  --into <dir>   Target skills directory (default: ~/.claude/skills)",
      "  --help, -h     Show this message",
      "",
      "Example:",
      "  agents-js skill install grill-me --from ~/workspace/skills-js",
    ].join("\n")}\n`,
  );
}

export function resolvePackagedSkillPath(moduleUrl = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const packageRoot =
    path.basename(moduleDir) === "dist" || path.basename(moduleDir) === "src"
      ? path.dirname(moduleDir)
      : moduleDir;
  return path.join(packageRoot, SKILL_RELATIVE_PATH);
}

/**
 * Ordered search paths for a skill name inside a skills source directory.
 * skills-js projects harness-native skills under `.claude/skills/` and keeps
 * the canonical source under `skills/`; we prefer the projected claude form,
 * fall back to canonical, then the directory itself (for a bare skills dir).
 *
 * This keeps agents-js free of any skills-js code dependency — the source is a
 * plain filesystem directory consumed through the `@agents-js/skills` loader.
 */
export function skillSourceSearchPaths(from: string): string[] {
  return [path.join(from, ".claude", "skills"), path.join(from, "skills"), from];
}

interface SkillInstallArgs {
  from?: string;
  into?: string;
  help?: boolean;
}

const SKILL_INSTALL_ARG_SPEC: ArgSpec<SkillInstallArgs> = {
  "--from": {
    kind: "value",
    assign: (a, v) => {
      a.from = v;
    },
    description: "Skills source directory (e.g. a skills-js checkout).",
    valueExample: "<dir>",
  },
  "--into": {
    kind: "value",
    assign: (a, v) => {
      a.into = v;
    },
    description: "Target skills directory (default: ~/.claude/skills).",
    valueExample: "<dir>",
  },
  "--help": {
    kind: "flag",
    assign: (a) => {
      a.help = true;
    },
  },
  "-h": {
    kind: "flag",
    assign: (a) => {
      a.help = true;
    },
  },
};

export interface SkillInstallDependencies {
  output?: Pick<NodeJS.WriteStream, "write">;
  home?: string;
  /** Injectable recursive copy (src dir -> dest dir) for deterministic tests. */
  copy?: (src: string, dest: string) => void;
}

/**
 * `agents-js skill install <name> --from <dir>` — resolve a skill from a
 * skills source via `@agents-js/skills`, validate it parses, and copy its
 * directory into a harness skills dir (default `~/.claude/skills`). This is the
 * harness-native install half of the skills seam (the other half is
 * skills-as-MCP through `agents-js mcp`).
 */
export function runSkillInstall(argv: string[], deps: SkillInstallDependencies = {}): number {
  const output = deps.output ?? process.stdout;
  const home = deps.home ?? homedir();
  const copy = deps.copy ?? ((src, dest) => cpSync(src, dest, { recursive: true }));

  let name: string | undefined;
  const flags: string[] = [];
  for (const a of argv) {
    if (name === undefined && !a.startsWith("-")) {
      name = a;
      continue;
    }
    flags.push(a);
  }

  let parsed: SkillInstallArgs;
  try {
    parsed = parseArgv<SkillInstallArgs>(flags, SKILL_INSTALL_ARG_SPEC, {
      subcommandName: "skill install",
      defaults: {},
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    printSkillInstallHelp(process.stderr);
    return EXIT_USAGE;
  }

  if (parsed.help) {
    printSkillInstallHelp(output);
    return EXIT_OK;
  }
  if (!name) {
    process.stderr.write("[agents-js skill install] missing required <skill-name>\n");
    printSkillInstallHelp(process.stderr);
    return EXIT_USAGE;
  }
  if (!parsed.from) {
    process.stderr.write("[agents-js skill install] --from <skills-source-dir> is required\n");
    printSkillInstallHelp(process.stderr);
    return EXIT_USAGE;
  }

  const searchPaths = skillSourceSearchPaths(parsed.from);
  const dir = resolveSkillDir(name, searchPaths);
  if (!dir) {
    process.stderr.write(
      `[agents-js skill install] skill "${name}" not found under ${parsed.from} (looked in: ${searchPaths.join(", ")})\n`,
    );
    return EXIT_ERROR;
  }

  // Validate the source parses as a skill before copying it anywhere.
  try {
    loadSkill(name, { searchPaths });
  } catch (err) {
    if (err instanceof SkillLoadError) {
      process.stderr.write(`[agents-js skill install] "${name}" failed to load: ${err.message}\n`);
      return EXIT_ERROR;
    }
    throw err;
  }

  const into = parsed.into ?? path.join(home, ".claude", "skills");
  const dest = path.join(into, name);
  copy(dir, dest);
  output.write(`[agents-js] skill install: "${name}" -> ${dest} (from ${dir})\n`);
  return EXIT_OK;
}

export async function runSkillCommand(
  argv: string[],
  dependencies: SkillCommandDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? process.stdout;

  if (argv[0] === "install") {
    return runSkillInstall(argv.slice(1), { output });
  }

  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    printSkillHelp(output);
    return EXIT_OK;
  }

  if (argv.length > 0) {
    process.stderr.write(`[agents-js] Unknown skill argument: ${argv[0]}\n`);
    printSkillHelp(process.stderr);
    return EXIT_USAGE;
  }

  const skillPath = resolvePackagedSkillPath(dependencies.moduleUrl);
  const content = await (dependencies.readFile ?? ((filePath) => readFile(filePath, "utf8")))(
    skillPath,
  );
  output.write(content.endsWith("\n") ? content : `${content}\n`);
  return EXIT_OK;
}
