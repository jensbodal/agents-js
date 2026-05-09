/**
 * Interactive terminal prompt functions for the `agents-js serve` command.
 *
 * Extracted from serve.ts to isolate TTY-dependent logic and make the
 * serve orchestrator easier to scan and test.
 */

import {
  type GatewayRuntimeId,
  type GatewayRuntimeSelection,
  getGatewayRuntimeDefinition,
  listGatewayRuntimeIds,
  parseCustomArgsJson,
} from "@agents-js/gateway-runtime";
import type { PromptChoice, PromptSession } from "./prompts.ts";

export type PersistMode = "ask-each-time" | "none" | "project" | "user";

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function promptForRuntimeSelection(
  prompt: PromptSession,
  detectedRuntimeIds: GatewayRuntimeId[],
): Promise<GatewayRuntimeSelection> {
  const curatedChoices = listGatewayRuntimeIds().map((runtimeId) => {
    const definition = getGatewayRuntimeDefinition(runtimeId);
    const detected = detectedRuntimeIds.includes(runtimeId);
    return {
      value: runtimeId,
      label: definition.displayName,
      hint: detected ? "detected locally" : definition.install.installHint,
    } satisfies PromptChoice<GatewayRuntimeId>;
  });

  const selection = await prompt.select("Choose an ACP harness", [
    ...curatedChoices,
    {
      value: "custom",
      label: "Advanced: custom ACP command",
      hint: "Provide your own command + args",
    },
  ]);

  if (selection !== "custom") {
    return {
      kind: "curated",
      runtime: selection,
    };
  }

  const command = await prompt.input("Custom ACP command");
  const argsRaw = await prompt.input("Custom ACP args JSON", "[]");
  return {
    kind: "custom",
    command,
    args: parseCustomArgsJson(argsRaw),
    displayName: "Custom ACP Runtime",
    description: "Operator-selected custom ACP runtime.",
  };
}

export async function promptForPersistMode(prompt: PromptSession): Promise<PersistMode> {
  return prompt.select("How should agents-js remember these defaults?", [
    {
      value: "user",
      label: "Save in user config",
      hint: "~/.config/agents-js/config.json",
    },
    {
      value: "project",
      label: "Save in project config",
      hint: ".agents-js/config.json",
    },
    {
      value: "ask-each-time",
      label: "Ask each time",
      hint: "Remember the policy, not the harness",
    },
    {
      value: "none",
      label: "Do not save",
      hint: "Use this selection only once",
    },
  ]);
}
