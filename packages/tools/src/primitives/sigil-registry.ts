/**
 * Sigil Registry — DOT-282
 *
 * A sigil is a structured prefix that triggers special resolution in the
 * orchestrator's input pipeline. This module provides parsing, registration,
 * and dispatch for sigil-prefixed input strings.
 *
 * ## Sigil syntax
 *
 * | Prefix | SigilKind  | Example           |
 * |--------|------------|-------------------|
 * | `$`    | `"dollar"` | `$skill run-docs` |
 * | `@@`   | `"at-at"`  | `@@dispatch task` |
 * | `!`    | `"bang"`   | `!ls -la`         |
 *
 * ## `$keyword` vs `$skill` disambiguation
 *
 * The spec lists four named sigils but both `$keyword` and `$skill` share the
 * `$` prefix. At parse time these collapse into a single `"dollar"` kind —
 * `parseSigil` cannot syntactically distinguish them. Multiple resolvers can
 * be registered against `"dollar"`; the local-first chain walks them in
 * **registration order**, each returning either `{ status: "handled", value }`
 * or `UNHANDLED`. The first registered resolver takes precedence. Register
 * keyword-expansion before skill-execution if keyword resolution should win on
 * ambiguous input.
 *
 * Forward-compat: if future versions need syntactic disambiguation (e.g.
 * `$$skill` vs `$keyword`), add new `SigilKind` values then.
 *
 * ## `!command` built-in
 *
 * The built-in `!command` resolver always returns `UNHANDLED`. Hosts register
 * their own policy-aware resolver (via `@agents-js/policy`'s
 * `validateTerminalRequest`) to avoid coupling `packages/tools/` to ACP host
 * internals.
 */

// ─── Core types ──────────────────────────────────────────────────────────────

/**
 * Discriminated union of all recognised sigil prefix categories.
 *
 * Three values, not four — `$keyword` and `$skill` are both `"dollar"` at
 * parse time. See module docstring for rationale.
 */
export type SigilKind = "dollar" | "at-at" | "bang";

/**
 * A parsed sigil: its category (`kind`) and the bare token after the prefix
 * (`name`). Trailing arguments are NOT part of the sigil; they belong in
 * `SigilContext.args`.
 *
 * Example: `$skill run-docs arg1` => `{ kind: "dollar", name: "skill" }`,
 * `SigilContext.args = ["run-docs", "arg1"]`.
 */
export interface Sigil {
  kind: SigilKind;
  name: string;
}

/**
 * Runtime context forwarded to every resolver invocation.
 *
 * `args` carries whitespace-split tokens that follow the sigil name in the
 * original input string. Resolvers may inspect or forward them as needed.
 * Attach arbitrary resolver-private data via `metadata`.
 */
export interface SigilContext {
  /** Tokens following the sigil name (space-split, may be empty). */
  args: string[];
  /** Open extension bag for host-side context (session id, auth tokens, etc). */
  metadata?: Record<string, unknown>;
}

/**
 * Successful resolution result. `value` is opaque at the registry layer;
 * the resolver and its caller agree on the shape.
 */
export interface HandledResult {
  status: "handled";
  value: unknown;
}

/**
 * Sentinel returned when a resolver declines to handle a sigil, passing
 * control to the next registered resolver for the same kind.
 */
export interface UnhandledResult {
  status: "unhandled";
}

/** Discriminated union of {@link HandledResult} and {@link UnhandledResult}. */
export type ResolverResult = HandledResult | UnhandledResult;

/**
 * Sentinel constant. Resolvers should `return UNHANDLED` rather than
 * constructing `{ status: "unhandled" }` inline — it is more readable and
 * the reference equality makes test assertions straightforward.
 */
export const UNHANDLED: UnhandledResult = Object.freeze({ status: "unhandled" });

/**
 * A function that attempts to resolve a parsed sigil in the given context.
 * Returns {@link UNHANDLED} to pass control to the next resolver in the chain.
 */
export type SigilResolver = (
  sigil: Sigil,
  context: SigilContext,
) => ResolverResult | Promise<ResolverResult>;

/**
 * Thrown when `resolve` is called for a `SigilKind` that has no registered
 * resolver and every applicable resolver has returned `UNHANDLED`.
 *
 * `code` follows the `"tools/<slug>"` convention from the rest of this package.
 */
export class SigilResolutionError extends Error {
  readonly code: string;
  constructor(message: string, code = "tools/sigil-unresolved") {
    super(message);
    this.name = "SigilResolutionError";
    this.code = code;
  }
}

/**
 * Registry surface for sigil resolvers. Use {@link createSigilRegistry} to
 * obtain an isolated instance.
 */
export interface SigilRegistry {
  /**
   * Register a resolver for a given sigil kind.
   *
   * Resolvers are tried in **registration order** — the first resolver
   * registered for a kind runs first. If it returns `UNHANDLED`, the next
   * one runs, and so on. This is the "local-first chain" contract.
   *
   * Registering the same resolver function twice for the same kind is
   * allowed (it will be called twice). If uniqueness is needed, the caller
   * is responsible for de-duplication.
   */
  register(kind: SigilKind, resolver: SigilResolver): void;

  /**
   * Parse `input` and dispatch to the resolver chain for the matched kind.
   *
   * Throws {@link SigilResolutionError} when:
   * - `input` does not match any recognised sigil prefix, OR
   * - no resolver is registered for the matched kind, OR
   * - all registered resolvers return `UNHANDLED`.
   */
  resolve(input: string, context: SigilContext): Promise<HandledResult>;
}

// ─── parseSigil ──────────────────────────────────────────────────────────────

/**
 * Regex table. Order matters: `@@` must be tested before a bare `@` would be
 * (not currently a sigil, but good practice). `!` last.
 * Anchored to start-of-string after optional leading whitespace.
 * Captures the bare name token (no spaces, non-empty).
 *
 * Name token: `[^\s]+` — everything up to the next whitespace. Args
 * (anything after the first space following name) are parsed by the caller
 * and forwarded via `SigilContext.args`.
 */
const SIGIL_PATTERNS: Array<{ kind: SigilKind; re: RegExp }> = [
  { kind: "at-at", re: /^\s*@@([^\s]+)/ },
  { kind: "dollar", re: /^\s*\$([^\s]+)/ },
  { kind: "bang", re: /^\s*!([^\s]+)/ },
];

/**
 * Parse a raw input string into a {@link Sigil}.
 *
 * Returns `null` when the input does not start with a recognised sigil prefix
 * (after optional leading whitespace). The prefix must be immediately followed
 * by a non-empty, non-whitespace token; a bare `$` with nothing after it does
 * not parse.
 *
 * Whitespace tolerance: strips leading whitespace before matching; `"  $skill"`
 * parses the same as `"$skill"`.
 *
 * Name extraction: captures only the first whitespace-delimited token after
 * the prefix. `"$skill run-docs arg1"` => `{ kind: "dollar", name: "skill" }`.
 * Remaining tokens are the caller's responsibility (see {@link SigilContext.args}).
 */
export function parseSigil(input: string): Sigil | null {
  if (typeof input !== "string" || input.trim().length === 0) {
    return null;
  }
  for (const { kind, re } of SIGIL_PATTERNS) {
    const m = re.exec(input);
    if (m?.[1]) {
      return { kind, name: m[1] };
    }
  }
  return null;
}

// ─── extractArgs ─────────────────────────────────────────────────────────────

/**
 * Parse the whitespace-split tokens that follow the sigil name in `input`.
 *
 * Used internally to build `SigilContext.args` when `resolve` is called with
 * a raw input string and the caller did not pre-populate `context.args`.
 *
 * extractArgs("$skill run-docs arg1 arg2") => ["run-docs", "arg1", "arg2"]
 * extractArgs("@@dispatch") => []
 */
/**
 * Matches the leading sigil prefix (`@@`, `$`, or `!`) plus its name
 * token. Regex captures both the multi-char prefix alternation and the
 * "everything until next whitespace" name in one declarative step;
 * doing this with `.indexOf` + branch-per-prefix is more code.
 */
const SIGIL_PREFIX_AND_NAME = /^(@@|[$!])[^\s]*/;

function extractArgs(input: string): string[] {
  const trimmed = input.trimStart();
  // Remove the prefix (`@@`, `$`, or `!`) and the name token, then split remainder.
  const afterPrefix = trimmed.replace(SIGIL_PREFIX_AND_NAME, "");
  return afterPrefix.trim().split(/\s+/).filter(Boolean);
}

// ─── Built-in resolvers ───────────────────────────────────────────────────────

/**
 * Built-in `!command` resolver. Always returns `UNHANDLED`.
 *
 * Hosts MUST register their own `"bang"` resolver that calls through
 * `@agents-js/policy`'s `validateTerminalRequest` before executing any
 * shell command. This stub exists so the kind is always in the chain but
 * cannot accidentally execute anything without an explicit host resolver.
 */
export const builtinCommandResolver: SigilResolver = (_sigil, _context) => UNHANDLED;

// ─── createSigilRegistry ─────────────────────────────────────────────────────

/**
 * Create a fresh, isolated {@link SigilRegistry}.
 *
 * The returned registry has the built-in `!command` fallback (which always
 * returns `UNHANDLED`) pre-registered so the `"bang"` kind is always in the
 * chain. Hosts that want terminal dispatch register their own resolver for
 * `"bang"` BEFORE the built-in, and it will take precedence.
 *
 * Example:
 *
 *   const registry = createSigilRegistry();
 *
 *   // Keyword-expansion resolver (higher priority -- registered first)
 *   registry.register("dollar", (sigil, ctx) => {
 *     if (sigil.name === "keyword") {
 *       return { status: "handled", value: expandKeyword(ctx) };
 *     }
 *     return UNHANDLED;
 *   });
 *
 *   // Skill-execution resolver (lower priority -- registered second)
 *   registry.register("dollar", (sigil, ctx) => {
 *     return { status: "handled", value: executeSkill(sigil.name, ctx) };
 *   });
 *
 *   const result = await registry.resolve("$keyword expand me", { args: [] });
 */
export function createSigilRegistry(): SigilRegistry {
  // Ordered resolver chains per kind. push-on-register preserves first-registered-wins order.
  const chains = new Map<SigilKind, SigilResolver[]>([
    ["dollar", []],
    ["at-at", []],
    ["bang", [builtinCommandResolver]],
  ]);

  return {
    register(kind: SigilKind, resolver: SigilResolver): void {
      const chain = chains.get(kind);
      if (!chain) {
        // Guard against runtime callers passing arbitrary strings via `as SigilKind`.
        chains.set(kind, [resolver]);
        return;
      }
      chain.push(resolver);
    },

    async resolve(input: string, context: SigilContext): Promise<HandledResult> {
      const sigil = parseSigil(input);
      if (!sigil) {
        throw new SigilResolutionError(
          `Input does not match any recognised sigil prefix: ${JSON.stringify(input)}`,
          "tools/sigil-parse-failed",
        );
      }

      const chain = chains.get(sigil.kind) ?? [];
      if (chain.length === 0) {
        throw new SigilResolutionError(
          `No resolver registered for sigil kind "${sigil.kind}" (parsed from ${JSON.stringify(input)})`,
          "tools/sigil-no-resolver",
        );
      }

      // Merge parsed args into context — only auto-extract when caller passed empty args.
      const enrichedContext: SigilContext = {
        ...context,
        args: context.args.length > 0 ? context.args : extractArgs(input),
      };

      for (const resolver of chain) {
        const result = await resolver(sigil, enrichedContext);
        if (result.status === "handled") {
          return result;
        }
      }

      throw new SigilResolutionError(
        `All resolvers returned UNHANDLED for sigil "${sigil.kind}:${sigil.name}" (input: ${JSON.stringify(input)})`,
        "tools/sigil-unresolved",
      );
    },
  };
}

// ─── Public helper ────────────────────────────────────────────────────────────

/**
 * Convenience wrapper: parse `input` and dispatch via `registry.resolve`.
 *
 * Equivalent to `registry.resolve(input, context)` — provided so callers that
 * hold both a registry and a raw string do not need to import the method form
 * separately.
 *
 * @throws {@link SigilResolutionError} on parse failure or full UNHANDLED chain.
 */
export async function resolveSigil(
  registry: SigilRegistry,
  input: string,
  context: SigilContext,
): Promise<HandledResult> {
  return registry.resolve(input, context);
}
