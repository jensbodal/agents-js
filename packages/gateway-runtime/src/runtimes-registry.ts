/**
 * Curated runtime registry — declarative metadata for every harness the
 * gateway knows how to spawn, plus the type definitions that describe its
 * shape.
 *
 * This file is intentionally data-heavy. The imperative resolver/lookup logic
 * is split across `./runtime-command-resolution.ts`,
 * `./runtime-selection.ts`, and `./acp-agent-entry-runtime.ts`, with
 * `./runtimes.ts` preserved as the public facade. Adding a new ACP harness
 * should only touch this file plus, when the harness needs install metadata,
 * `./generated-runtime-installs.ts`.
 */
import type { GatewayCardInput } from "@agents-js/a2a";
import type { ACPProcessOptions } from "@agents-js/acp";
import {
  CLAUDE_AGENT_ACP_PACKAGE_NAME,
  CLAUDE_AGENT_ACP_VERSION,
  CODEX_ACP_PACKAGE_NAME,
  CODEX_ACP_VERSION,
} from "./generated-runtime-installs.ts";
import type { ResolvedRuntimeProfile, RuntimeProfile } from "./profiles/types.ts";

export interface GatewayRuntimeInstall {
  owner: "external" | "zed" | "agentclientprotocol" | "custom" | "agents-js";
  packageName?: string;
  packageBinPath?: string;
  version?: string;
  installHint: string;
}

export interface GatewayRuntimeResolveArgsInput {
  /**
   * The base argv for this runtime, already copied from `definition.args`.
   * Implementations may append, prepend, or return a rewritten tuple. The
   * hook must NOT mutate the input array.
   */
  baseArgs: string[];
  /**
   * Env snapshot used for flag-level overrides (e.g. `AJS_RUNTIME_LOG_LEVEL`).
   * Typically the live `process.env`, but tests pass an explicit record.
   */
  env: Record<string, string | undefined>;
}

/**
 * Semantic LLM provider id an agent/runtime authenticates against. The cred
 * env-var requirement is a property of the PROVIDER, not the runtime — a
 * runtime that can target multiple providers (e.g. pi: zai|anthropic|…) needs a
 * different key per provider, so the provider is the single source of truth for
 * which secret env keys to forward.
 */
export type ProviderId = "anthropic" | "openai" | "zai" | "factory" | "google";

/**
 * Provider → credential env-var NAMES (never values). The mapping lives here
 * ONCE; runtimes declare a {@link GatewayRuntimeDefinition.defaultProvider}
 * instead of hand-maintaining their own `authEnvKeys` list. `google` is empty
 * by design — the gemini CLI self-authenticates (OAuth/gcloud) with no env
 * passthrough.
 */
export const PROVIDER_CRED_ENV: Readonly<Record<ProviderId, readonly string[]>> = Object.freeze({
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  zai: ["ZAI_API_KEY"],
  factory: ["FACTORY_API_KEY"],
  google: [],
});

/**
 * Resolve a provider's credential env-key names. Fail-closed: an absent or
 * unrecognized provider yields NO keys (never a wildcard), so a misconfigured
 * provider can only ever NARROW the secret-env allowlist, never widen it.
 */
export function resolveProviderCredEnvKeys(provider: string | undefined): readonly string[] {
  if (!provider) return [];
  return PROVIDER_CRED_ENV[provider as ProviderId] ?? [];
}

export interface GatewayRuntimeDefinition {
  id: string;
  displayName: string;
  description: string;
  command: string;
  args: string[];
  install: GatewayRuntimeInstall;
  resolvesFromWorkspaceBin: boolean;
  workspaceFlag?: string;
  /**
   * Environment variables that should always be set for this runtime when
   * resolved, independent of profile-level env overrides. Intended for
   * runtime-specific hygiene defaults (telemetry opt-outs, internal-mode
   * flags, etc.) that operators shouldn't have to re-specify per profile.
   * Profile `env` merges on top of this — profile entries win on conflict.
   */
  defaultEnv?: Record<string, string>;
  /**
   * Harness-specific credential/auth env var names that the host
   * composition layer must forward from the parent process into the spawned
   * runtime, and block from being overridden via `extraEnv`. Treat this as
   * the per-harness source of truth for credential passthrough; the host
   * passes it into `StartConfig.envPolicy.agentSecretEnvKeys` when starting
   * an ACP session. Leave `undefined` (or empty) when a harness manages its
   * own credentials out-of-band (e.g. `pi` persists auth in `~/.pi`).
   *
   * Curated harnesses no longer hand-maintain this — it is DERIVED from
   * {@link defaultProvider} via {@link PROVIDER_CRED_ENV} (see
   * {@link createAcpHarness}). The field remains the host-facing source of
   * truth so consumers (`buildHostRuntimeEnvPolicy`, `cli/acp.ts`) are
   * unchanged.
   */
  authEnvKeys?: readonly string[];
  /**
   * Semantic provider this runtime authenticates against by default. The
   * runtime's `authEnvKeys` are derived from it ({@link PROVIDER_CRED_ENV}), so
   * the provider→cred mapping is declared once, by the provider. A multi-provider
   * runtime (pi) carries its most common provider here; per-agent provider
   * override is a follow-on.
   */
  defaultProvider?: ProviderId;
  /**
   * Optional per-definition hook that produces the runtime's final argv.
   *
   * When present, {@link resolveRuntimeArgs} delegates to this hook instead
   * of returning `baseArgs` unchanged. Use it for per-harness flag surfaces
   * that depend on env toggles (log-level flags, plugin-disable flags, etc.)
   * — adding support for a new harness becomes a config change rather than
   * a new `if (definition.id === …)` branch inside the resolver.
   *
   * Contract:
   * - Must return a fresh array; do not mutate `input.baseArgs`.
   * - Must be a deterministic function of `(baseArgs, env)` — no filesystem
   *   reads, no network, no reliance on globals beyond `env`, no hidden
   *   state across invocations.
   * - Stderr diagnostics are permitted (and expected) for invalid env
   *   values: emit a warning and fall back to a sensible default rather
   *   than throwing. These diagnostics are the one allowed side effect —
   *   everything else must be pure.
   */
  resolveArgs?: (input: GatewayRuntimeResolveArgsInput) => string[];
}

/**
 * Host-flavored {@link ACPProcessOptions} used for wiring resolved gateway
 * runtimes into `@agents-js/acp-host`'s `createHostACPProcess`. Mirrors the
 * `HostACPProcessOptions` interface exported from `@agents-js/acp-host` — the
 * structural duplicate exists so `@agents-js/gateway-runtime` can publish a
 * concrete shape for {@link ResolvedGatewayRuntime} without creating a
 * package-level dep cycle (acp-host depends on gateway-runtime for the derived
 * harness-auth env-key list). Keep the fields in sync with the canonical
 * definition at `packages/acp-host/src/types/process-options.ts`.
 */
export interface ResolvedGatewayRuntimeACPOptions extends ACPProcessOptions {
  workspaceFlag?: string;
  sessionCwd?: string;
  autoRecoverOpencodeDefaultAgent?: boolean;
}

export interface ResolvedGatewayRuntime {
  definition: GatewayRuntimeDefinition;
  acp: ResolvedGatewayRuntimeACPOptions;
  agentCard: GatewayCardInput;
}

export interface RuntimeCommandResolver {
  which(command: string): string | undefined;
  fileExists(filePath: string): Promise<boolean>;
}

export interface RuntimeResolutionOptions {
  /**
   * Explicit anchor directories for package-installed runtimes. The resolver
   * walks each directory and its parents looking for `node_modules/.bin`.
   */
  binSearchRoots?: readonly string[];
  modulePath?: string;
  resolver?: RuntimeCommandResolver;
  workspaceBinRoot?: string;
  /**
   * Optional profile name folded into the generated agent-card name so
   * two profiles of the same runtime ({pi-aggressive}, {pi-passive})
   * register under distinct names on a shared host. Pure metadata —
   * does not influence command/argv resolution. Curated selections that
   * carry a `profile` field on {@link GatewayRuntimeSelection} take
   * precedence over this option.
   */
  profile?: string;
}

/**
 * Gateway-runtime-flavored {@link RuntimeProfile}: identical shape, but the
 * `runtime` field is narrowed to {@link GatewayRuntimeId} so the curated
 * runtime registry is the source of truth for legal harness ids in this
 * surface. Pass instances of this type to `resolveGatewayRuntimeProfile`
 * and `applyGatewayRuntimeProfile`.
 */
export interface GatewayRuntimeProfile extends RuntimeProfile {
  runtime: GatewayRuntimeId;
}

/**
 * Gateway-runtime-flavored {@link ResolvedRuntimeProfile}, narrowed so that
 * the `definition.runtime` field carries {@link GatewayRuntimeId}.
 */
export interface ResolvedGatewayRuntimeProfile extends ResolvedRuntimeProfile {
  definition: GatewayRuntimeProfile;
}

export interface CustomGatewayRuntimeSelection {
  kind: "custom";
  command: string;
  args?: string[];
  displayName?: string;
  description?: string;
}

export interface CuratedGatewayRuntimeSelection {
  kind: "curated";
  profile?: string;
  runtime: GatewayRuntimeId;
}

export type GatewayRuntimeSelection =
  | CustomGatewayRuntimeSelection
  | CuratedGatewayRuntimeSelection;

/**
 * Input shape for {@link createAcpHarness}. Collocates the fields that a
 * curated ACP harness needs to declare in one call site — binary name, npm
 * package metadata, install hint, optional auth env keys, runtime hygiene
 * defaults, and argv hook — so adding a new harness is a single structured
 * edit and the host composition layer reads `authEnvKeys` from one place.
 */
export interface CreateAcpHarnessInput {
  id: string;
  displayName: string;
  description: string;
  command: string;
  args?: readonly string[];
  install: GatewayRuntimeInstall;
  resolvesFromWorkspaceBin: boolean;
  workspaceFlag?: string;
  defaultEnv?: Readonly<Record<string, string>>;
  resolveArgs?: GatewayRuntimeDefinition["resolveArgs"];
  /**
   * Semantic provider this harness authenticates against. Preferred over
   * {@link authEnvKeys}: the harness's cred keys are DERIVED from the provider
   * via {@link PROVIDER_CRED_ENV}, so the provider→cred mapping lives once.
   */
  defaultProvider?: ProviderId;
  /**
   * Harness-specific credential keys layered ON TOP of the provider-derived
   * ones (e.g. codex reads its own `CODEX_API_KEY` in addition to the openai
   * provider's `OPENAI_API_KEY`). Order: extras first, then provider keys.
   */
  extraAuthEnvKeys?: readonly string[];
  /**
   * Explicit override of the derived cred keys. Honored verbatim when set
   * (used by custom/test runtimes); curated harnesses use {@link defaultProvider}
   * instead and leave this unset.
   */
  authEnvKeys?: readonly string[];
}

/**
 * Factory for building a well-formed {@link GatewayRuntimeDefinition}. The
 * curated ACP harnesses are constructed via this factory so the per-harness
 * duplication (binary name +
 * install metadata + auth env keys) lives at a single call site.
 *
 * Emits a definition with the same byte-level shape the hand-written registry
 * entries used to have; fields absent from the input are omitted from the
 * output (rather than set to `undefined`) to preserve behavior tests that
 * assert on object shape.
 */
export function createAcpHarness(input: CreateAcpHarnessInput): GatewayRuntimeDefinition {
  const definition: GatewayRuntimeDefinition = {
    id: input.id,
    displayName: input.displayName,
    description: input.description,
    command: input.command,
    args: input.args ? [...input.args] : [],
    install: input.install,
    resolvesFromWorkspaceBin: input.resolvesFromWorkspaceBin,
  };
  if (input.workspaceFlag !== undefined) {
    definition.workspaceFlag = input.workspaceFlag;
  }
  if (input.defaultEnv !== undefined) {
    definition.defaultEnv = { ...input.defaultEnv };
  }
  if (input.resolveArgs !== undefined) {
    definition.resolveArgs = input.resolveArgs;
  }
  if (input.defaultProvider !== undefined) {
    definition.defaultProvider = input.defaultProvider;
  }
  // authEnvKeys precedence: an explicit override wins (custom/test runtimes);
  // otherwise DERIVE from the provider (extras first, then provider keys,
  // deduped). Only set the field when non-empty so out-of-band-auth runtimes
  // (gemini, trial, mock) keep `authEnvKeys` absent, as before.
  const derivedAuthEnvKeys =
    input.authEnvKeys ??
    Array.from(
      new Set([
        ...(input.extraAuthEnvKeys ?? []),
        ...resolveProviderCredEnvKeys(input.defaultProvider),
      ]),
    );
  if (derivedAuthEnvKeys.length > 0) {
    definition.authEnvKeys = derivedAuthEnvKeys;
  }
  return definition;
}

const OPENCODE_LOG_LEVELS = new Set(["DEBUG", "INFO", "WARN", "ERROR"]);

/**
 * Translate `AJS_RUNTIME_LOG_LEVEL` into the `--print-logs --log-level <LEVEL>`
 * flags expected by opencode's CLI surface. Returns `null` to mean "omit log
 * flags entirely" (silent / off / explicit empty), or the flag tuple to append.
 *
 * Lives next to the opencode definition because it is a pure helper consumed
 * exclusively by the opencode `resolveArgs` hook below — keeping them adjacent
 * means contributors editing opencode's argv behavior see the level set in one
 * scroll.
 */
function resolveOpencodeLogFlags(rawLevel: string | undefined): string[] | null {
  if (rawLevel === undefined) {
    return ["--print-logs", "--log-level", "INFO"];
  }

  const trimmed = rawLevel.trim();
  if (trimmed === "") {
    return null;
  }

  const upper = trimmed.toUpperCase();
  if (upper === "SILENT" || upper === "OFF") {
    return null;
  }

  if (OPENCODE_LOG_LEVELS.has(upper)) {
    return ["--print-logs", "--log-level", upper];
  }

  // Unknown value: warn once and fall back to INFO rather than hard-erroring.
  process.stderr.write(
    `[agents-js] Unknown AJS_RUNTIME_LOG_LEVEL="${rawLevel}"; falling back to INFO. ` +
      `Valid values: debug, info, warn, error, silent (or off).\n`,
  );
  return ["--print-logs", "--log-level", "INFO"];
}

const gatewayRuntimeRegistry = {
  opencode: createAcpHarness({
    id: "opencode",
    displayName: "OpenCode ACP",
    description:
      "OpenCode's ACP runtime launched through the opencode CLI. User-environment plugins (e.g. oh-my-openagent) are loaded normally; set AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS=1 to append --pure when a broken plugin (such as oh-my-openagent's ZWSP sort-prefix injection) needs to be neutralized. Default runtime args include --print-logs --log-level INFO; override via AJS_RUNTIME_LOG_LEVEL=debug|info|warn|error|silent.",
    command: "opencode",
    args: ["acp"],
    install: {
      owner: "external",
      installHint: 'Install or otherwise provide the "opencode" CLI on PATH.',
    },
    resolvesFromWorkspaceBin: false,
    workspaceFlag: "--cwd",
    // Hygiene defaults — opencode ships with anonymous telemetry + PostHog
    // analytics enabled by default. Disable both unconditionally; operators
    // who want telemetry can override via a profile-level env entry.
    defaultEnv: {
      OMO_SEND_ANONYMOUS_TELEMETRY: "0",
      OMO_DISABLE_POSTHOG: "1",
    },
    // Per-harness argv hook. Handles the two env-driven toggles specific to
    // opencode's flag surface:
    //
    // - `AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS=1|true` → append `--pure` to
    //   neutralize known upstream plugin bugs (e.g. oh-my-openagent's ZWSP
    //   sort-prefix injection). Strict opt-in; other truthy-looking values
    //   (including "0" and "") leave the default behavior unchanged.
    // - `AJS_RUNTIME_LOG_LEVEL=debug|info|warn|error|silent|off` → append
    //   `--print-logs --log-level <LEVEL>` so operators see runtime
    //   diagnostics on stderr. `silent`/`off`/"" omit both flags; unknown
    //   values warn once and fall back to INFO rather than hard-erroring.
    resolveArgs: ({ baseArgs, env }) => {
      const args = [...baseArgs];
      const disablePlugins = env.AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS;
      if (disablePlugins === "1" || disablePlugins === "true") {
        args.push("--pure");
      }
      const logFlags = resolveOpencodeLogFlags(env.AJS_RUNTIME_LOG_LEVEL);
      if (logFlags) {
        args.push(...logFlags);
      }
      return args;
    },
  }),
  claude: createAcpHarness({
    id: "claude",
    displayName: "Claude ACP",
    description:
      "Claude ACP runtime published as @agentclientprotocol/claude-agent-acp (the upstream-canonical home of the package previously published as @zed-industries/claude-agent-acp).",
    command: "claude-agent-acp",
    install: {
      owner: "agentclientprotocol",
      packageName: CLAUDE_AGENT_ACP_PACKAGE_NAME,
      version: CLAUDE_AGENT_ACP_VERSION,
      installHint:
        'Use the published @agents-js/cli package, or install "@agentclientprotocol/claude-agent-acp" on PATH.',
    },
    resolvesFromWorkspaceBin: true,
    // claude-agent-acp reads ANTHROPIC_API_KEY from the inherited env.
    // Declared explicitly per-harness — the host no longer forwards a
    // global baseline, so each runtime owns its own credential surface.
    defaultProvider: "anthropic",
  }),
  codex: createAcpHarness({
    id: "codex",
    displayName: "Codex ACP",
    description:
      "Zed's Codex ACP runtime published as @zed-industries/codex-acp. The adapter is OpenAI's publicly endorsed ACP bridge for the Codex CLI (see openai/codex#2785). Authenticates via CODEX_API_KEY or OPENAI_API_KEY; ChatGPT-subscription login (codex login) works locally but is not usable in remote-spawned contexts. Runs stdio-only — no workspace flag is surfaced because codex-acp derives its working directory from the spawning process.",
    command: "codex-acp",
    install: {
      owner: "zed",
      packageName: CODEX_ACP_PACKAGE_NAME,
      version: CODEX_ACP_VERSION,
      installHint:
        'Use the published @agents-js/cli package, or install "@zed-industries/codex-acp" on PATH.',
    },
    resolvesFromWorkspaceBin: true,
    // Auth passthrough for the codex-acp harness. codex-acp accepts either
    // CODEX_API_KEY (preferred) or OPENAI_API_KEY; ChatGPT-subscription
    // cookie auth works locally only. We forward both env keys so the
    // adapter can choose whichever the operator has configured.
    defaultProvider: "openai",
    extraAuthEnvKeys: ["CODEX_API_KEY"],
  }),
  pi: createAcpHarness({
    id: "pi",
    displayName: "Pi ACP",
    description:
      'ACP adapter for Mario Zechner\'s Pi coding agent (@mariozechner/pi-coding-agent), wrapping the native "pi --mode rpc" NDJSON stream. The adapter is maintained in-repo as @agents-js/pi-acp and ships a `pi-acp` binary. Pi manages provider auth internally via its own "/login" TUI flow, persisted ~/.pi credentials, or provider env vars read by the Pi CLI itself. Runtime profile args are forwarded to Pi after `--mode rpc`, so profiles can select provider/model/tool flags; PI_ACP_PI_COMMAND can point at a specific Pi binary when PATH shims need it. The "pi" CLI must be separately installed on PATH (npm i -g @mariozechner/pi-coding-agent). Runs stdio-only — no workspace flag is surfaced because pi-acp derives its working directory from the spawning process.',
    command: "pi-acp",
    install: {
      owner: "agents-js",
      packageName: "@agents-js/pi-acp",
      packageBinPath: "dist/pi-acp",
      installHint:
        'The in-repo "pi-acp" binary is built from @agents-js/pi-acp; ensure the "pi" CLI is also installed (npm i -g @mariozechner/pi-coding-agent).',
    },
    resolvesFromWorkspaceBin: true,
    // Pi is multi-provider; its default here is Zai. The host forwards the
    // provider's cred key (derived: zai → ZAI_API_KEY) to the pi-acp child so
    // the nested Pi process authenticates headlessly — there is no /login TUI in
    // the gateway path. Per-agent provider override is a follow-on.
    defaultProvider: "zai",
  }),
  droid: createAcpHarness({
    id: "droid",
    displayName: "Droid ACP",
    description:
      'ACP adapter for Factory.ai\'s Droid CLI, wrapping per-turn "droid exec --output-format stream-json" invocations. The adapter is maintained in-repo as @agents-js/droid-acp and ships a `droid-acp` binary. Droid reads FACTORY_API_KEY from the environment (or its local credential cache under ~/.factory); the host forwards FACTORY_API_KEY into the spawned child via the per-harness `authEnvKeys` declared below. Runtime profile args are forwarded to each `droid exec` invocation after adapter-owned session/cwd flags and before the prompt. The "droid" CLI must be separately installed on PATH. Runs stdio-only — no workspace flag is surfaced because droid-acp forwards the ACP NewSessionRequest cwd directly to each `droid exec --cwd` invocation.',
    command: "droid-acp",
    install: {
      owner: "agents-js",
      packageName: "@agents-js/droid-acp",
      packageBinPath: "dist/droid-acp",
      installHint:
        'The in-repo "droid-acp" binary is built from @agents-js/droid-acp; ensure the "droid" CLI is also installed (see https://docs.factory.ai/cli).',
    },
    resolvesFromWorkspaceBin: true,
    // Droid authenticates via FACTORY_API_KEY. Declaring it here makes the
    // host composition layer forward the variable into the spawned child
    // and block it from being overridden by untrusted extraEnv input.
    defaultProvider: "factory",
  }),
  gemini: createAcpHarness({
    id: "gemini",
    displayName: "Gemini ACP",
    description: "Google's Gemini CLI ACP runtime launched through the gemini CLI.",
    command: "gemini",
    args: ["--acp"],
    install: {
      owner: "external",
      installHint: 'Install or otherwise provide the "gemini" CLI on PATH.',
    },
    resolvesFromWorkspaceBin: false,
    // No `resolveArgs` hook yet — gemini (like claude, codex, pi) currently
    // takes its static argv unchanged. If we start wanting per-env flag
    // surfaces (log-level, plugin-toggle, etc.) the hook pattern used by
    // `opencode` above is the drop-in — it's intentionally empty here so
    // contributors see the scaffold-in-use case before they grow a new one.
  }),
  trial: createAcpHarness({
    id: "trial",
    displayName: "Trial Agent",
    description:
      "In-repo ACP agent that exercises @agents-js/tools primitives over the real ACP wire. Not for production use — registered only to validate that fetchContext / findTools / readiness-gate assertions work end-to-end through an actual ACP session. The `trial-agent` binary is provided by the in-repo @agents-js/trial-agent package; bun symlinks it into node_modules/.bin during workspace install. Authentication: none — every primitive operates on local fs only.",
    command: "trial-agent",
    install: {
      owner: "agents-js",
      packageName: "@agents-js/trial-agent",
      installHint:
        'The "trial-agent" binary is provided by the in-repo @agents-js/trial-agent package and resolved from node_modules/.bin after `bun install`. No external install required.',
    },
    resolvesFromWorkspaceBin: true,
    // No authEnvKeys — trial agent uses local workspace state only, no
    // external API keys.
  }),
  "mock-acp": createAcpHarness({
    id: "mock-acp",
    displayName: "Mock ACP",
    description:
      "Deterministic in-repo ACP mock for CI. Responds to every session/prompt with a canned reply without touching any external service. Registered only when AGENTS_JS_ENABLE_MOCK_ACP_RUNTIME=1. Not for production use.",
    command: "mock-acp",
    install: {
      owner: "agents-js",
      packageName: "@agents-js/gateway-runtime",
      installHint:
        'The "mock-acp" binary is provided by @agents-js/gateway-runtime and resolved from node_modules/.bin after `bun install`. No external install required.',
    },
    resolvesFromWorkspaceBin: true,
    // No authEnvKeys — mock uses no external credentials.
  }),
} as const satisfies Record<string, GatewayRuntimeDefinition>;

export type GatewayRuntimeId = keyof typeof gatewayRuntimeRegistry;

/**
 * Curated runtime registry, exposed as a read-only `Record` so the selection
 * layer can iterate and look up entries. The type is widened from the literal
 * `as const` shape to `Readonly<Record<…>>` so downstream consumers see a
 * stable structural type rather than the raw string-literal-keyed object.
 */
export const GATEWAY_RUNTIME_REGISTRY: Readonly<
  Record<GatewayRuntimeId, GatewayRuntimeDefinition>
> = gatewayRuntimeRegistry;

/**
 * Default directories the gateway prepends to `process.env.PATH` when
 * resolving runtime binaries via the resolver in
 * `./runtime-command-resolution.ts`. The host composition layer threads this
 * list into `StartConfig.extraBinPaths` so the spawned ACP child sees the
 * same augmented PATH the resolver used at registry time — if we can
 * resolve codex/gemini at registry time but the child can't re-execute
 * them, the split was definitionally wrong.
 *
 * Why these specific entries:
 * - `/usr/local/bin`, `/opt/homebrew/bin` — Homebrew roots (Intel + Apple
 *   Silicon). Covers opencode and most Homebrew-installed tools.
 * - `${HOME}/.bun/bin`, `${HOME}/local/bun/bin` — Bun global install roots.
 *   Covers user-installed @zed-industries/* ACP bridges and other bun-linked
 *   CLIs (e.g. the `claude-agent-acp` binary found at `~/local/bun/bin/`).
 * - `${HOME}/.local/bin` — mise main bin shim (and general user-local fallback).
 * - `${HOME}/.local/share/mise/shims` — mise per-tool shims. Covers codex,
 *   gemini, and any other mise-managed npm/github tool. GUI-launched shells
 *   often inherit a shorter `PATH`, so including this path keeps runtime
 *   resolution consistent across terminal and desktop launch paths.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder resolved at runtime
export const HOME_PLACEHOLDER = "${HOME}";
export const DEFAULT_EXTRA_BIN_PATHS: readonly string[] = Object.freeze([
  "/usr/local/bin",
  "/opt/homebrew/bin",
  `${HOME_PLACEHOLDER}/.bun/bin`,
  `${HOME_PLACEHOLDER}/local/bun/bin`,
  `${HOME_PLACEHOLDER}/.local/bin`,
  `${HOME_PLACEHOLDER}/.local/share/mise/shims`,
]);

/**
 * Env var that gates registration of the in-repo `mock-acp` runtime in
 * {@link listGatewayRuntimeIds}. Surfaced as a constant rather than an inline
 * string so tests and consumers can reference the same key.
 */
export const MOCK_ACP_RUNTIME_ENV = "AGENTS_JS_ENABLE_MOCK_ACP_RUNTIME";

/**
 * Structural shape required by `resolveAcpAgentEntryToRuntime`. Defined
 * locally (rather than imported from `@agents-js/a2a-client/node`) to avoid
 * introducing a new workspace dependency from `gateway-runtime`. Callers
 * typically pass an `ACPAgentEntry` from the registry, which is structurally
 * compatible with this shape.
 */
export interface AcpAgentEntryInput {
  /** Harness identifier (e.g. `"claude"`, `"opencode"`, `"gemini"`). */
  harness: string;
  /** Optional display name for custom-command entries. */
  name?: string;
  /** Optional override command; falls back to the curated harness binary. */
  command?: string;
  /** Optional args to pass through to the resolved runtime. */
  args?: string[];
  /** Optional env overlay merged onto the runtime's default env. */
  env?: Record<string, string>;
  /** Optional override for the workspace flag (e.g. `"--directory"`, `"--cwd"`). */
  workspaceFlag?: string;
}
