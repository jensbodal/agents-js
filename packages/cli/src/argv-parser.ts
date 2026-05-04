/**
 * Tiny table-driven argv parser shared by the `serve`, `acp`, and
 * `bridge` subcommands. Each subcommand declares a {@link ArgSpec}
 * mapping `--flag` strings to assignment functions, then delegates to
 * {@link parseArgv} for the actual loop.
 *
 * Two flag shapes are supported:
 *
 * - `kind: "flag"`  — boolean flag with no value (e.g. `--help`).
 *   Multiple flag tokens may share a single assign (e.g. `--help` and
 *   `-h`) by using {@link defineFlag} with two entries pointing at the
 *   same assign function.
 * - `kind: "value"` — flag that consumes the next argv token as its
 *   value (e.g. `--harness opencode`). Missing-value detection is
 *   handled by {@link consumeValue} so the diagnostic matches the
 *   pre-existing error contract.
 *
 * The parser is intentionally minimal: it does not support `--flag=value`
 * inline syntax, short-flag clustering, or `--` end-of-options markers.
 * Those would only be added if a subcommand actually needs them.
 *
 * Design notes:
 *
 * - The `assign` callback owns its validator. Per-flag normalization
 *   (e.g. `parseRuntimeLogLevel`, `parsePort`) lives in `cli-utils.ts`
 *   and is invoked from inside `assign`. This keeps the spec table
 *   declarative without surrendering type-safe value handling.
 * - Unknown flags throw via the spec's `unknownFlagMessage` so each
 *   subcommand can keep its own pre-existing error wording (`"Unknown
 *   acp argument: ..."`, `"Unknown serve argument: ..."`, etc.).
 */

import { consumeValue } from "./cli-utils.ts";

export interface FlagEntry<TArgs> {
  kind: "flag";
  assign: (args: TArgs) => void;
}

export interface ValueEntry<TArgs> {
  kind: "value";
  assign: (args: TArgs, value: string) => void;
}

export type ArgEntry<TArgs> = FlagEntry<TArgs> | ValueEntry<TArgs>;

/**
 * Map of `--flag` token → entry handler. Values omitted intentionally
 * over typing as `Record<string, ArgEntry<...>>` so that callers can
 * keep the literal-key shape inferable for IDE jump-to-definition.
 */
export type ArgSpec<TArgs> = Record<string, ArgEntry<TArgs>>;

export interface ParseArgvOptions<TArgs> {
  /** Subcommand name used in the unknown-flag diagnostic. */
  subcommandName: string;
  /** Optional initial defaults applied before walking argv. */
  defaults?: Partial<TArgs>;
}

/**
 * Walk `argv` and dispatch each token through `spec`. The caller's
 * `defaults` (if any) seed the result object; entries mutate the result
 * in place via their `assign` callbacks.
 */
export function parseArgv<TArgs extends object>(
  argv: string[],
  spec: ArgSpec<TArgs>,
  options: ParseArgvOptions<TArgs>,
): TArgs {
  const result = { ...(options.defaults ?? {}) } as TArgs;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const entry = spec[flag];
    if (!entry) {
      throw new Error(`[agents-js] Unknown ${options.subcommandName} argument: ${flag}`);
    }

    if (entry.kind === "flag") {
      entry.assign(result);
      continue;
    }

    // kind === "value"
    const value = consumeValue(argv, ++index, flag);
    entry.assign(result, value);
  }

  return result;
}
