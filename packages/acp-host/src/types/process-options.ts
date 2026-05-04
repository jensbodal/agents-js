import type { ACPProcessOptions } from "@agents-js/acp";
import type { HostEnvPolicyInput } from "../env-policy.ts";

/**
 * Host-specific process spawn options, extending the low-level
 * `ACPProcessOptions` from `@agents-js/acp` with fields that only
 * `createHostACPProcess` (in this package) interprets.
 *
 * `workspaceFlag` lived on `ACPProcessOptions` historically but was
 * only ever read by `createHostACPProcess`, which is a layer inversion.
 * Moving it here restores the layering: low-level spawn helpers in
 * `@agents-js/acp` don't need to know about workspace propagation, and
 * host-managed helpers in this package do.
 */
export interface HostACPProcessOptions extends ACPProcessOptions {
  /**
   * Workspace-directory CLI flag (e.g. `--directory`, `--cwd`) that
   * `createHostACPProcess` appends to spawn args alongside the workspace
   * path. Defaults to `"--directory"` when the caller doesn't specify.
   * Pass an explicit empty string or a custom flag for runtimes that
   * need a different flag name.
   */
  workspaceFlag?: string;
  /**
   * Effective session cwd to use for spawn `cwd` and the optional workspace
   * CLI flag. Defaults to the workspace identity root when omitted.
   */
  sessionCwd?: string;
  /**
   * Explicit opt-in for opencode-specific auto-recovery: when opencode
   * reports `session/new` failing with JSON-RPC `-32603` + `data.details`
   * matching `/default agent "(.+)" not found/`, the session controller
   * restarts the underlying process with `--pure` appended and retries
   * once. Set only for the opencode curated profile; never sniff on
   * `command` suffix, since a third-party wrapper could rename the
   * binary. Claude/gemini do not share this failure mode — a missing
   * default agent from them is a legitimate config error.
   */
  autoRecoverOpencodeDefaultAgent?: boolean;
  /**
   * Additional directories appended to the spawned process's PATH. Used by
   * GUI-launched hosts whose inherited PATH may omit user-local tool roots
   * (e.g. mise shims, Bun global bin). Empty / duplicate segments are
   * filtered.
   */
  extraBinPaths?: readonly string[];
  /**
   * When `true`, pass the real `HOME` through to the spawned agent instead
   * of a deterministic per-workspace sandbox directory. Required for
   * runtimes that read credentials or config from `~/.config/...`.
   */
  allowRealHome?: boolean;
  /**
   * Caller-supplied env-var policy. The host has no harness knowledge, so
   * embedders pass the per-runtime auth-key set (and optional overrides for
   * inherited / terminal / forbidden keys) here. See {@link HostEnvPolicyInput}.
   */
  envPolicy?: HostEnvPolicyInput;
}
