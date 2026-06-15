/**
 * `agents-js onboard <agent>` — conformant onboarding entry point.
 *
 * Onboard resolves the selected launch-config entry, prepares the agent's
 * identity workspace, then delegates process startup to `agents-js launch`. For
 * the `pi` harness that means a **native peer** that joins the agents-js A2A
 * mesh (the pi-extension binds a localhost A2A endpoint and self-registers).
 *
 * On a successful launch it ALSO emits the agent's **mesh-join dispatch entry**
 * — the `{kind:"a2a", url}` record the gateway operator installs so
 * `@@dispatch <agent>` routes to this peer. This collapses trust + dispatch
 * registration into one onboarding step (AJS #41): previously a peer was
 * trust-registered but still required a separate manual `agents-js registry add`
 * before it was routable. agents-js EMITS the artifact; the gateway operator
 * INSTALLS it (see ONBOARDING.md "Mesh-join boundary").
 *
 * The fuller onboarding vision layers in here WITHOUT changing the verb:
 * skills provisioning (skills-as-MCP via skills-js, `agents-js mcp setup`),
 * identity registration, and the rest of the machine-readable mesh-join
 * bundle. Keeping `onboard` as the stable surface lets those steps accrete
 * behind one command.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  loadLaunchConfig,
  parseEnvSetup,
  resolveAgentEntry,
  resolveLanAdvertiseHost,
  resolvePiAdvertiseHost,
} from "@agents-js/agent-launch";
import { EXIT_ERROR, EXIT_OK } from "./exit-codes.ts";
import { type LaunchCommandDependencies, resolveConfigPath, runLaunchCommand } from "./launch.ts";

const execFileAsync = promisify(execFile);

export interface OnboardCommandDependencies extends LaunchCommandDependencies {
  initGit?: (workspace: string) => Promise<void>;
}

/**
 * Print `agents-js onboard` usage. Kept distinct from `launch`'s help: onboard
 * adds the mesh-join dispatch emit on top of launch, so `--help` must describe
 * that — not silently forward to launch's help wrapped in launching/launched
 * banners (which is what happened before the short-circuit in
 * {@link runOnboardCommand}).
 */
function printOnboardUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      "Usage:",
      "  agents-js onboard <agent-name> [options]",
      "",
      "Conformant onboarding: prepare the identity workspace, launch (or attach",
      "to) an agent, then emit the agent's mesh-join dispatch entry so",
      "`@@dispatch <agent>` routes to it. Skills + registry provisioning layer in",
      "via `agents-js mcp setup` (see ONBOARDING.md).",
      "",
      "Options:",
      "  --bg, --background, -d   Create the launch session detached (passed to launch)",
      "  --config <path>          Override the agent-launch config search path",
      "  --help, -h               Show this message",
      "",
      "The mesh-join dispatch entry is emitted only when the agent has a fixed",
      "A2A port (pi_port) and a resolvable advertise host; ephemeral-port agents",
      "self-register locally and are not stable cross-host dispatch targets.",
      "",
      "Examples:",
      "  agents-js onboard my-agent",
      "  agents-js onboard my-agent --config ./agent-launch-config.json",
    ].join("\n")}\n`,
  );
}

/**
 * Parse the onboard target — the agent name (first non-flag token) and an
 * explicit `--config <path>` — mirroring {@link runLaunchCommand}'s argv
 * handling so the post-launch emit re-resolves the same config + entry the
 * launch used. (`--config` consumes the following token as its value.)
 */
export function parseOnboardTarget(argv: string[]): {
  agentName?: string;
  configPath?: string;
} {
  let agentName: string | undefined;
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--config") {
      configPath = argv[i + 1];
      i++;
      continue;
    }
    if (agentName === undefined && token !== undefined && !token.startsWith("-")) {
      agentName = token;
    }
  }
  return { agentName, configPath };
}

/** A2A dispatch registry entry the gateway operator installs for a peer. */
export interface MeshJoinDispatchEntry {
  readonly name: string;
  readonly url: string;
}

/**
 * Build the A2A dispatch registry entry that makes a peer reachable via
 * `@@dispatch <name>` (AJS #41 option b). Returns `null` when the agent has no
 * fixed A2A port (ephemeral-port agents self-register in the LOCAL registry and
 * are not stable cross-host dispatch targets) or no resolvable advertise host.
 *
 * The URL is built from the resolved advertise host — the q4m FQDN when a LAN
 * domain is configured (not a raw IP), so the entry survives LAN IP-drift.
 */
export function buildMeshJoinDispatchEntry(
  agentName: string,
  piPort: string | undefined,
  advertiseHost: string | undefined,
): MeshJoinDispatchEntry | null {
  if (!piPort || !advertiseHost) {
    return null;
  }
  return { name: agentName, url: `http://${advertiseHost}:${piPort}` };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

async function writeSeedFileOnce(filePath: string, text: string): Promise<boolean> {
  try {
    await writeFile(filePath, text, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (isAlreadyExistsError(error)) return false;
    throw error;
  }
}

async function defaultInitGit(workspace: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: workspace });
}

function resolveMatrixAgent(agentName: string, envSetup: string | undefined): string {
  if (!envSetup) return agentName;
  try {
    return parseEnvSetup(envSetup, agentName).MATRIX_AGENT ?? agentName;
  } catch {
    return agentName;
  }
}

function readmeSeed(agentName: string): string {
  return `${[
    `# ${agentName}`,
    "",
    "Native Pi identity workspace created by `agents-js onboard`.",
    "",
    "This workspace holds the agent identity, handoff notes, and local runtime state. Sandboxed source-repo editing is a separate future integration.",
  ].join("\n")}\n`;
}

function handoffSeed(agentName: string): string {
  return `${[
    `# ${agentName} Handoff`,
    "",
    "## Current Status",
    "",
    "- Fresh identity workspace created.",
    "",
    "## Next Notes",
    "",
    "- Add operator handoff details here as the agent starts work.",
  ].join("\n")}\n`;
}

function identitySeed(agentName: string, matrixAgent: string, workspace: string): string {
  return `${[
    `# ${agentName} Identity`,
    "",
    `- MATRIX_AGENT=${matrixAgent}`,
    `- Workspace: ${workspace}`,
    "- Harness: pi",
    "",
    "This file identifies the native Pi workspace. It does not imply source-repo sandbox isolation.",
  ].join("\n")}\n`;
}

async function bootstrapIdentityWorkspace(
  agentName: string,
  workspace: string,
  matrixAgent: string,
  output: Pick<NodeJS.WriteStream, "write">,
  dependencies: OnboardCommandDependencies,
): Promise<void> {
  let createdWorkspace = false;
  try {
    const existing = await stat(workspace);
    if (!existing.isDirectory()) {
      throw new Error(`[agents-js] onboard: workspace path is not a directory: ${workspace}`);
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
    await mkdir(workspace, { recursive: true });
    createdWorkspace = true;
  }

  let initializedGit = false;
  if (!(await pathExists(path.join(workspace, ".git")))) {
    await (dependencies.initGit ?? defaultInitGit)(workspace);
    initializedGit = true;
  }

  const identityDir = path.join(workspace, ".agents", agentName);
  await mkdir(identityDir, { recursive: true });
  const seeded = await Promise.all([
    writeSeedFileOnce(path.join(workspace, "README.md"), readmeSeed(agentName)),
    writeSeedFileOnce(path.join(workspace, "HANDOFF.md"), handoffSeed(agentName)),
    writeSeedFileOnce(
      path.join(identityDir, "identity.md"),
      identitySeed(agentName, matrixAgent, workspace),
    ),
  ]);
  const seededCount = seeded.filter(Boolean).length;
  output.write(
    `[agents-js] onboard: workspace ready (${createdWorkspace ? "created" : "existing"}, git ${initializedGit ? "initialized" : "existing"}, ${seededCount} seed file${seededCount === 1 ? "" : "s"} created)\n`,
  );
}

export async function runOnboardCommand(
  argv: string[],
  dependencies: OnboardCommandDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? process.stdout;
  // biome-ignore lint/style/noProcessEnv: CLI entry-point default; tests inject via dependencies.env.
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const cwd = dependencies.cwd ?? process.cwd();

  // Short-circuit on --help BEFORE the launch path: otherwise onboard prints its
  // launching banner, forwards to launch's --help, then prints "harness
  // launched" — surfacing launch's help wrapped in misleading banners and never
  // describing onboard's own mesh-join behavior.
  if (argv.includes("--help") || argv.includes("-h")) {
    printOnboardUsage(output);
    return EXIT_OK;
  }

  const { agentName, configPath } = parseOnboardTarget(argv);
  if (agentName) {
    try {
      const resolvedConfigPath = resolveConfigPath({ configPath }, env, home, cwd);
      const config = await loadLaunchConfig(resolvedConfigPath);
      const entry = resolveAgentEntry(config, agentName);
      if (entry.harness === "pi") {
        await bootstrapIdentityWorkspace(
          agentName,
          entry.workspace,
          resolveMatrixAgent(agentName, entry.envSetup),
          output,
          dependencies,
        );
      }
    } catch (error) {
      output.write(
        `[agents-js] onboard: bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return EXIT_ERROR;
    }
  }

  output.write("[agents-js] onboard: launching agent onto the mesh...\n");
  const code = await runLaunchCommand(argv, dependencies);
  if (code !== 0) {
    return code;
  }
  output.write(
    "[agents-js] onboard: harness launched. Skills + registry provisioning layer via `agents-js mcp setup` (see ONBOARDING.md).\n",
  );

  // #41(b): emit the A2A dispatch registry entry for the gateway operator to
  // install, so `@@dispatch <agent>` routes here without a separate manual
  // `registry add`. Best-effort — the launch already succeeded, so a
  // post-launch resolution hiccup must never flip the exit code.
  try {
    if (agentName) {
      const resolvedConfigPath = resolveConfigPath({ configPath }, env, home, cwd);
      const config = await loadLaunchConfig(resolvedConfigPath);
      const entry = resolveAgentEntry(config, agentName);
      if (entry.harness !== "pi") return code;
      const advertiseHost = resolvePiAdvertiseHost(entry.piHost, () =>
        resolveLanAdvertiseHost({
          lanDomain: config.lanDomain ?? env.AGENTS_JS_LAN_DOMAIN,
        }),
      );
      const dispatchEntry = buildMeshJoinDispatchEntry(agentName, entry.piPort, advertiseHost);
      if (dispatchEntry) {
        const bundle = {
          agents: { [dispatchEntry.name]: { kind: "a2a", url: dispatchEntry.url } },
        };
        output.write(
          `[agents-js] onboard: mesh-join dispatch entry — install on the gateway so \`@@dispatch ${dispatchEntry.name}\` routes here:\n`,
        );
        output.write(`${JSON.stringify(bundle, null, 2)}\n`);
        output.write(
          `  or: agents-js registry add ${dispatchEntry.name} --kind a2a --url ${dispatchEntry.url}\n`,
        );
      } else {
        output.write(
          `[agents-js] onboard: "${agentName}" has no fixed A2A port — it self-registers in the local registry and is not a stable cross-host @@dispatch target. Set pi_port (and lan_domain) for a cross-host dispatch entry.\n`,
        );
      }
    }
  } catch {
    // Best-effort emit; never fail onboarding on a post-launch resolution issue.
  }
  return code;
}
