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
 *
 * Single-value semantics. A multi-value variant
 * ({@link harnessesArg}) exists for the gateway-process binaries
 * (`serve`, `agents-js-gateway`); commands that wrap exactly one
 * harness (`bridge`, `send`, `registry`) use this single-value form.
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

export interface HarnessesArg {
  /**
   * Ordered list of curated harness ids the gateway should expose. The
   * first entry is the **primary** routing target (used for sessions
   * with no per-request override); subsequent entries are secondary,
   * lazy-spawned, available but not auto-bound. The gateway-process
   * binaries (`serve`, `agents-js-gateway`) use this shape; bridge /
   * send / registry use the single-value {@link HarnessArg}.
   *
   * Empty / undefined = no flag passed (interactive wizard prompts in
   * `serve`, default selection in `agents-js-gateway`).
   */
  harnesses?: string[];
}

/**
 * `--harness` / `--harnesses` — multi-value runtime-selection
 * fragment for the gateway-process binaries (`serve`, internal
 * gateway). Both spellings populate the same `harnesses` array; order
 * is preserved across mixed forms (`--harness x --harnesses y,z` →
 * `["x", "y", "z"]`). The first listed id is the primary routing
 * target.
 *
 * Single-harness back-compat: `--harness opencode` alone produces
 * `["opencode"]` — downstream resolves to a one-entry runtime list,
 * with byte-identical behavior to the original single-harness
 * invocation form.
 */
export function harnessesArg<T extends HarnessesArg>(): ArgSpec<T> {
  return {
    "--harness": {
      kind: "value",
      assign: (a, v) => {
        a.harnesses ??= [];
        a.harnesses.push(v);
      },
      description:
        "Select a curated harness or enter custom mode. Repeatable: pass --harness multiple times to declare the harness fleet in argv order (first = primary). Currently only the primary is resolved; secondary harnesses are accepted by the parser but not yet routed.",
      valueExample: "<id|custom>",
    },
    "--harnesses": {
      kind: "value",
      assign: (a, v) => {
        a.harnesses ??= [];
        for (const id of v
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)) {
          a.harnesses.push(id);
        }
      },
      description:
        "Comma-separated list of curated harnesses (first = primary). Equivalent to repeating --harness. Currently only the primary is resolved; secondary harnesses are accepted by the parser but not yet routed.",
      valueExample: "<id1,id2,...>",
    },
  };
}

export interface CardNameArg {
  cardName?: string;
}

/**
 * `--card-name` — explicit override for the agent card `name` field
 * advertised on the gateway and written into the shared registry.
 * Overrides both the profile-derived default (`${runtimeId}-acp-gateway`)
 * and the legacy `universal-acp-gateway` fallback. Use this when two
 * gateway processes for the same runtime+profile combination must
 * co-host on a single machine without overwriting each other's
 * registry entries.
 *
 * Env-var equivalent: `AGENTS_JS_CARD_NAME` (resolved at the call site,
 * not here, so this fragment stays a pure spec).
 */
export function cardNameArg<T extends CardNameArg>(): ArgSpec<T> {
  return {
    "--card-name": {
      kind: "value",
      assign: (a, v) => {
        a.cardName = v;
      },
      description:
        "Explicit agent-card name override (default: `<runtime>[-<profile>]-acp-gateway`). Use when co-hosting multiple gateway processes for the same runtime+profile.",
      valueExample: "<name>",
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

export interface HeartbeatArgs {
  heartbeatIntervalMs?: number;
  heartbeatEnabled?: boolean;
}

/**
 * `--heartbeat-interval-ms`, `--heartbeat-enabled`, `--no-heartbeat`
 * — control the host-address heartbeat (AJS-87). The heartbeat is
 * the publisher-side half of a DDNS-like contract for the federated
 * registry: each tick re-publishes this gateway's `(name, url)` record
 * with a fresh `registered_at` so peers pulling the local sync
 * endpoint see a current entry even after a DHCP roam.
 *
 * Default is **on** with a 60-second interval. Heartbeat fires
 * independently of `--registry-sync` — local auto-registration
 * always runs, and so does its periodic refresh. The corresponding
 * environment variables (`AGENTS_JS_HEARTBEAT_INTERVAL_MS` and
 * `AGENTS_JS_HEARTBEAT_ENABLED`) are resolved at the call site, not
 * here, to keep this fragment a pure spec.
 *
 * `--heartbeat-enabled` and `--no-heartbeat` are mutually exclusive
 * shorthands; the last flag wins under the standard argv-parser
 * left-to-right pass.
 */
export function heartbeatArgs<T extends HeartbeatArgs>(): ArgSpec<T> {
  return {
    "--heartbeat-interval-ms": {
      kind: "value",
      assign: (a, v) => {
        const parsed = Number(v);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(
            `[agents-js] Invalid --heartbeat-interval-ms "${v}". Expected a non-negative number.`,
          );
        }
        a.heartbeatIntervalMs = parsed;
      },
      description:
        "Host-address heartbeat interval in milliseconds (default: 60000; 0 disables the loop).",
      valueExample: "<ms>",
    },
    "--heartbeat-enabled": {
      kind: "flag",
      assign: (a) => {
        a.heartbeatEnabled = true;
      },
      description: "Enable the host-address heartbeat (default: enabled).",
    },
    "--no-heartbeat": {
      kind: "flag",
      assign: (a) => {
        a.heartbeatEnabled = false;
      },
      description: "Disable the host-address heartbeat (initial registration still runs).",
    },
  };
}

export interface AcpCommandAndProfileArgs {
  acpArgsJson?: string;
  acpCommand?: string;
  profile?: string;
}

/**
 * `--acp-command`, `--acp-args-json`, `--profile` — runtime-selection
 * flags excluding the harness flag itself. Lets serve (multi-harness
 * via {@link harnessesArg}) and acp (single-harness via
 * {@link harnessArg}) share the custom-command and profile flag set
 * while opting into different harness-selection forms.
 */
export function acpCommandAndProfileArgs<T extends AcpCommandAndProfileArgs>(): ArgSpec<T> {
  return {
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

export interface RuntimeSelectArgs extends HarnessArg, AcpCommandAndProfileArgs {}

/**
 * `--harness`, `--acp-command`, `--acp-args-json`, `--profile` — full
 * runtime-selection flag set for acp (single-harness). serve uses
 * {@link harnessesArg} + {@link acpCommandAndProfileArgs} instead so
 * it can accept multiple harnesses.
 */
export function runtimeSelectArgs<T extends RuntimeSelectArgs>(): ArgSpec<T> {
  return {
    ...harnessArg<T>(),
    ...acpCommandAndProfileArgs<T>(),
  };
}
