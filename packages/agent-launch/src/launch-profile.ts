/**
 * A2 increment 2 — launch-profile derivation for numbered identities.
 *
 * Maps a parsed {@link AgentIdentity} to the structured launch shape that an
 * executor (and the dot-cognee fleet package) needs, for BOTH operational
 * profile classes (per Jens's 2026-06-02 model reset — these are distinct
 * operational AgentProfiles, not one identity with interchangeable modes):
 *
 *   native      (`<host>-<harness>-<N>`)      → run the harness binary directly
 *                                                on the operator host; provider
 *                                                env (e.g. ZAI_API_KEY) read by
 *                                                the harness itself; no gateway.
 *   ajs-fronted (`<host>-ajs-<harness>-<N>`)  → run `agents-js-gateway --runtime
 *                                                <harness>` on the gateway/runtime
 *                                                host; the gateway spawns the
 *                                                co-located ACP adapter (e.g.
 *                                                pi-acp → `pi --mode rpc`); A2A
 *                                                faces outward.
 *
 * **Boundary**: pure derivation. No spawn, no filesystem, no env mutation, no
 * cross-host execution — that's the executor layer. This module is the reusable
 * primitive `@agents-js/agent-launch` owns; the fleet package supplies the
 * roster data (identities, gopass refs) and proves the live smokes.
 *
 * **Verified invocations** (read from source, not assumed): the gateway selects
 * runtimes via `--runtime <id>` (`apps/internal-gateway/cli-args.ts`); the pi
 * runtime is `id: "pi"`, `command: "pi-acp"` (`gateway-runtime` registry);
 * native Pi reads `ZAI_API_KEY` directly (Pi supports Zai natively — no LiteLLM).
 */

import type { AgentIdentity, HarnessToken } from "./identity-scheme.ts";
import { deriveRuntimeHost } from "./identity-scheme.ts";

/** Operational class of a launch — the native-vs-AJS-fronted runtime-path axis. */
export type LaunchPathMode = "native" | "ajs-fronted";

/**
 * Provider env var read directly by a harness (no adapter/LiteLLM in the path).
 * Pi supports Zai natively via `ZAI_API_KEY`. Harnesses absent from this map
 * manage provider auth by other means (e.g. claude via its own credential flow)
 * and derive `undefined`.
 */
export const HARNESS_PROVIDER_ENV: Partial<Record<HarnessToken, string>> = Object.freeze({
  pi: "ZAI_API_KEY",
});

/** Native binary name per harness token (the direct, non-fronted harness CLI). */
export const HARNESS_NATIVE_BINARY: Partial<Record<HarnessToken, string>> = Object.freeze({
  claude: "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  pi: "pi",
  droid: "droid",
});

/** The command an executor runs, by launch mode. */
export interface LaunchCommandSpec {
  /** native → the harness binary; ajs-fronted → the gateway binary. */
  readonly command: string;
  /** Argv (excluding operator fresh-flags, which the plan layer appends). */
  readonly args: readonly string[];
}

/** Structured launch profile derived from a numbered identity. */
export interface AgentLaunchProfile {
  readonly identity: AgentIdentity;
  readonly launchMode: LaunchPathMode;
  /** Where the runtime actually runs (native → operator host; fronted → gateway host). */
  readonly runtimeHost: string;
  /** Provider env var the harness reads directly, if any (e.g. `ZAI_API_KEY`). */
  readonly providerEnvVar?: string;
  /** The command shape for the executor. */
  readonly commandSpec: LaunchCommandSpec;
}

export interface DeriveLaunchProfileOptions {
  /** Host of the gateway that fronts ajs identities (e.g. LXC189). */
  readonly gatewayHost: string;
  /** Gateway port for ajs-fronted runs; appended as `--port <n>` when set. */
  readonly gatewayPort?: number;
  /** Override the native binary (e.g. a pinned path); defaults per harness. */
  readonly nativeBinary?: string;
}

/**
 * Derive the {@link AgentLaunchProfile} for a parsed numbered identity. Pure.
 *
 * - native: `command` = the harness binary (operator host); provider env set.
 * - ajs-fronted: `command` = `agents-js-gateway --runtime <harness> [--port N]`
 *   on the gateway host; provider env still applies (the gateway-spawned harness
 *   reads it).
 */
export function deriveLaunchProfile(
  identity: AgentIdentity,
  options: DeriveLaunchProfileOptions,
): AgentLaunchProfile {
  const launchMode: LaunchPathMode = identity.ajsFronted ? "ajs-fronted" : "native";
  const runtimeHost = deriveRuntimeHost(identity, options.gatewayHost);
  const providerEnvVar = HARNESS_PROVIDER_ENV[identity.harness];

  let commandSpec: LaunchCommandSpec;
  if (launchMode === "native") {
    const command =
      options.nativeBinary ?? HARNESS_NATIVE_BINARY[identity.harness] ?? identity.harness;
    commandSpec = { command, args: [] };
  } else {
    const args = ["--runtime", identity.harness];
    if (options.gatewayPort !== undefined) {
      args.push("--port", String(options.gatewayPort));
    }
    commandSpec = { command: "agents-js-gateway", args };
  }

  return Object.freeze({
    identity,
    launchMode,
    runtimeHost,
    ...(providerEnvVar !== undefined ? { providerEnvVar } : {}),
    commandSpec,
  });
}
