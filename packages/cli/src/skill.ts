import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";

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
      "  agents-js skill",
      "",
      "Print the installable agents-js SKILL.md document to stdout.",
      "",
      "Examples:",
      "  agents-js skill > ~/.codex/skills/agents-js/SKILL.md",
      "  agents-js skill > .agents/skills/agents-js/SKILL.md",
      "",
      "Options:",
      "  --help, -h  Show this message",
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

export async function runSkillCommand(
  argv: string[],
  dependencies: SkillCommandDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? process.stdout;

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
