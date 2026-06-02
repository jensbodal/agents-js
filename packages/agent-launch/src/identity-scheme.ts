/**
 * Structured parsing for the numbered agent-identity naming scheme (A2).
 *
 * Two identity classes share one grammar:
 *
 *   native:       `<operatorHost>-<harness>-<index>`        e.g. `olthoi0-claude-0`
 *   ajs-fronted:  `<operatorHost>-ajs-<harness>-<index>`    e.g. `olthoi0-ajs-claude-0`
 *
 * The `<operatorHost>` prefix is **operator-centric** — the host whose operator
 * owns the identity, NOT where the runtime physically runs. Runtime location is
 * **derived** from `ajsFronted` (see {@link deriveRuntimeHost}), grounded in the
 * ACP-is-local boundary: an ajs-fronted harness is spawned by the gateway over
 * stdio, so its ACP subprocess MUST be co-located with the gateway. A native
 * harness runs on the operator host directly.
 *
 * Legacy free-form profile names (`cognee-claude`, `agent-zero-dev`, …) do NOT
 * match this grammar; {@link parseAgentIdentity} returns `null` for them so the
 * 22 legacy profiles coexist untouched (lazy-migration, no forced cutover).
 *
 * **Critique-first reasoning**
 * - **Boundary**: pure, deterministic string parsing. No filesystem, no env, no
 *   process. Headless-unit-testable with literal inputs (the explicit NFR).
 * - **Default**: ambiguity resolves to `null` (legacy), never a guess. The
 *   discriminator is a KNOWN harness token in the harness slot + an all-digits
 *   index — both must hold, or it isn't the numbered scheme.
 * - **Contract**: returns a frozen {@link AgentIdentity} or `null`.
 * - **Safety**: operator hosts may contain hyphens (`hostname-null`); the parser
 *   anchors on the trailing `-<index>` and the harness token rather than a fixed
 *   segment count, so multi-segment hosts parse correctly.
 */

/** Short harness tokens used in the identity scheme (NOT the config harness kind). */
export const HARNESS_TOKENS = ["claude", "codex", "opencode", "gemini", "pi", "droid"] as const;
export type HarnessToken = (typeof HARNESS_TOKENS)[number];

const HARNESS_TOKEN_SET: ReadonlySet<string> = new Set(HARNESS_TOKENS);

/**
 * Map a scheme harness token to the `agent-launch-config.json` harness kind
 * consumed by {@link buildLaunchPlan}. Only `claude` is launch-supported today
 * (Phase 1); the rest map their kinds for forward use.
 */
export const HARNESS_TOKEN_TO_KIND: Readonly<Record<HarnessToken, string>> = Object.freeze({
  claude: "claude-code",
  codex: "codex-cli",
  opencode: "opencode",
  gemini: "gemini",
  pi: "pi",
  droid: "droid",
});

/** The marker segment that flags an ajs-fronted identity. */
const AJS_MARKER = "ajs";

/** Parsed numbered identity. */
export interface AgentIdentity {
  /** Operator/owner host — the prefix; NOT necessarily where the runtime runs. */
  readonly operatorHost: string;
  /** True when the harness runs behind the agents-js gateway (ACP on the gateway host). */
  readonly ajsFronted: boolean;
  /** Short harness token (`claude`, `pi`, …). */
  readonly harness: HarnessToken;
  /** Config harness kind (`claude-code`, …) — derived from {@link harness}. */
  readonly harnessKind: string;
  /** Numeric instance index. */
  readonly index: number;
  /** The original name, echoed for round-trip/diagnostics. */
  readonly name: string;
}

/**
 * Parse a numbered-scheme identity name. Returns `null` for any name that does
 * not match the grammar (legacy free-form profiles), so callers can branch on
 * `parsed === null` to keep the legacy path.
 */
export function parseAgentIdentity(name: string): AgentIdentity | null {
  if (typeof name !== "string" || name.length === 0) return null;
  const segments = name.split("-");
  // Need at least host + harness + index.
  if (segments.length < 3) return null;

  const indexSeg = segments.at(-1);
  const harnessSeg = segments.at(-2);
  if (indexSeg === undefined || harnessSeg === undefined) return null;
  if (!/^\d+$/.test(indexSeg)) return null; // trailing -<index> is mandatory
  const index = Number.parseInt(indexSeg, 10);

  if (!HARNESS_TOKEN_SET.has(harnessSeg)) return null; // known harness token gates the scheme

  // Segment immediately before the harness decides ajs-fronting.
  const beforeHarness = segments.slice(0, segments.length - 2);
  const ajsFronted = beforeHarness.at(-1) === AJS_MARKER;
  const hostSegs = ajsFronted ? beforeHarness.slice(0, -1) : beforeHarness;
  if (hostSegs.length === 0) return null; // operator host must be present

  const harness = harnessSeg as HarnessToken;
  return Object.freeze({
    operatorHost: hostSegs.join("-"),
    ajsFronted,
    harness,
    harnessKind: HARNESS_TOKEN_TO_KIND[harness],
    index,
    name,
  });
}

/**
 * Derive the host where the runtime actually runs:
 *   ajs-fronted → the fronting gateway's host (co-located ACP subprocess)
 *   native      → the operator host
 *
 * `gatewayHost` is the host of the gateway that fronts ajs identities (LXC189
 * today) — parameterized, never hardcoded, so multi-gateway fleets resolve
 * correctly.
 */
export function deriveRuntimeHost(identity: AgentIdentity, gatewayHost: string): string {
  return identity.ajsFronted ? gatewayHost : identity.operatorHost;
}
