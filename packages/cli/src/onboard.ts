/**
 * `agents-js onboard <agent>` — conformant onboarding entry point.
 *
 * Today this is a thin wrapper over `agents-js launch`: it resolves the agent's
 * config entry, builds the launch plan, and starts the harness. For the `pi`
 * harness that means a **native peer** that joins the agents-js A2A mesh
 * (the pi-extension binds a localhost A2A endpoint and self-registers).
 *
 * The fuller onboarding vision layers in here WITHOUT changing the verb:
 * skills provisioning (skills-as-MCP via skills-js, `agents-js mcp setup`),
 * identity/registry registration, and emitting the machine-readable mesh-join
 * bundle the gateway operator applies (the CLI emits; infra installs — see
 * ONBOARDING.md). Keeping `onboard` as the stable surface lets those steps
 * accrete behind one command.
 */

import { type LaunchCommandDependencies, runLaunchCommand } from "./launch.ts";

export async function runOnboardCommand(
  argv: string[],
  dependencies: LaunchCommandDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? process.stdout;
  output.write("[agents-js] onboard: launching agent onto the mesh…\n");
  const code = await runLaunchCommand(argv, dependencies);
  if (code === 0) {
    output.write(
      "[agents-js] onboard: harness launched. Skills + registry provisioning layer via `agents-js mcp setup` (see ONBOARDING.md).\n",
    );
  }
  return code;
}
