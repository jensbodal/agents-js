/**
 * Shared `ArgSpec` fragments composed by the `serve`, `bridge`, and `acp`
 * subcommands. Each fragment is a generic factory keyed on a
 * structural-minimum interface so individual subcommands can spread a
 * fragment into their own concrete args type without TypeScript
 * complaining about invariance on the assignment side of `ArgSpec`.
 *
 * Fragment factories (instead of plain constants) keep flag normalization
 * (port, runtime-log-level, profile name) co-located with the spec while
 * still letting each subcommand contribute its own command-specific flags.
 */

import { validateGatewayRuntimeProfileName } from "@agents-js/gateway-runtime";
import type { ArgSpec } from "./argv-parser.ts";
import { parsePort, parseRuntimeLogLevel } from "./cli-utils.ts";

export interface HostPortArgs {
  host?: string;
  port?: number;
}

/**
 * `--host` / `--port` — bind address for the A2A server (serve, bridge).
 */
export function hostPortArgs<T extends HostPortArgs>(): ArgSpec<T> {
  return {
    "--host": {
      kind: "value",
      assign: (a, v) => {
        a.host = v;
      },
      description: "Bind host for the A2A server (default: 127.0.0.1).",
      valueExample: "<host>",
    },
    "--port": {
      kind: "value",
      assign: (a, v) => {
        a.port = parsePort(v);
      },
      description: "Bind port (0 = auto-allocate).",
      valueExample: "<port>",
    },
  };
}

export interface RuntimeLogArgs {
  defaultModel?: string;
  opencodeDisableExternalPlugins?: boolean;
  runtimeLogLevel?: string;
}

/**
 * `--runtime-log-level`, `--opencode-disable-external-plugins`,
 * `--default-model` — runtime log/env knobs shared by serve, bridge, acp.
 */
export function runtimeLogArgs<T extends RuntimeLogArgs>(): ArgSpec<T> {
  return {
    "--runtime-log-level": {
      kind: "value",
      assign: (a, v) => {
        a.runtimeLogLevel = parseRuntimeLogLevel(v);
      },
      description: "Runtime log level (debug|info|warn|error|silent).",
      valueExample: "<level>",
    },
    "--opencode-disable-external-plugins": {
      kind: "flag",
      assign: (a) => {
        a.opencodeDisableExternalPlugins = true;
      },
      description: "Append --pure when launching opencode.",
    },
    "--default-model": {
      kind: "value",
      assign: (a, v) => {
        a.defaultModel = v;
      },
      description: "Default model id (AJS_DEFAULT_MODEL override).",
      valueExample: "<id>",
    },
  };
}

export interface HarnessArg {
  harness?: string;
}

/**
 * `--harness` only — the minimal runtime-selection fragment. Bridge
 * uses this directly; serve and acp compose it through
 * {@link runtimeSelectArgs} to add custom-command and profile flags.
 */
export function harnessArg<T extends HarnessArg>(): ArgSpec<T> {
  return {
    "--harness": {
      kind: "value",
      assign: (a, v) => {
        a.harness = v;
      },
      description: "Select a curated harness or enter custom mode.",
      valueExample: "<id|custom>",
    },
  };
}

export interface RegistrySyncArg {
  registrySync?: boolean;
}

/**
 * `--registry-sync` — opt in to cross-gateway registry sync. Default
 * is **off**: no inbound sync endpoint is mounted and no outbound
 * peer fetch interval is started. Local auto-registration is unaffected.
 *
 * The environment variable `AGENTS_JS_REGISTRY_SYNC=true` is the
 * equivalent toggle and is read at the call site (not here, so this
 * fragment stays a pure spec).
 */
export function registrySyncArg<T extends RegistrySyncArg>(): ArgSpec<T> {
  return {
    "--registry-sync": {
      kind: "flag",
      assign: (a) => {
        a.registrySync = true;
      },
      description: "Enable cross-gateway peer registry sync (default: off; A2A-only payload).",
    },
  };
}

export interface RuntimeSelectArgs extends HarnessArg {
  acpArgsJson?: string;
  acpCommand?: string;
  profile?: string;
}

/**
 * `--harness`, `--acp-command`, `--acp-args-json`, `--profile` — full
 * runtime-selection flag set for serve and acp.
 */
export function runtimeSelectArgs<T extends RuntimeSelectArgs>(): ArgSpec<T> {
  return {
    ...harnessArg<T>(),
    "--acp-command": {
      kind: "value",
      assign: (a, v) => {
        a.acpCommand = v;
      },
      description:
        "Custom ACP command (requires --harness custom or no --harness; mutually exclusive with curated).",
      valueExample: "<command>",
    },
    "--acp-args-json": {
      kind: "value",
      assign: (a, v) => {
        a.acpArgsJson = v;
      },
      description: "JSON array of custom ACP args (only valid with --acp-command).",
      valueExample: "<json>",
    },
    "--profile": {
      kind: "value",
      assign: (a, v) => {
        a.profile = validateGatewayRuntimeProfileName(v);
      },
      description:
        "Optional named profile for curated runtimes (not supported with --harness custom).",
      valueExample: "<name>",
    },
  };
}
