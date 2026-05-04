/**
 * Programmatic encoding of the seven D readiness gates from the first-cycle
 * plan (`hub/agents-js/plans/first-week-plan-2026-04-21-final.md`,
 * "Readiness gates" section under D — @agents-js/tools).
 *
 * Each gate maps to a single async assertion. Gates either:
 *
 * - PASS — the assertion held against the live primitives in `@agents-js/tools`.
 * - FAIL — the assertion was checked and the primitives returned an
 *   incorrect / unexpected shape; the trial agent surfaces this loudly so
 *   regressions in the underlying package can't slip through.
 * - DEFER — the assertion depends on a primitive D's first commit explicitly
 *   left for a follow-on (`searchRoomHistory` against Matrix, `searchAgentMsg`
 *   against the agent-msg DB). Per the task spec, deferred gates assert that
 *   the gap is signaled clearly rather than masked by silent empty results;
 *   they auto-tighten when the missing primitives land.
 *
 * The gate list is structured (`RD_GATE_IDS` is a const tuple) so the
 * integration test can assert by id rather than by ordinal index.
 */

import { defaultRegistry, fetchContext, findTools } from "@agents-js/tools";

/**
 * Stable ids for the seven gates, in execution order. Exported as a `const`
 * tuple so downstream consumers (the integration test, future report
 * renderers) can switch on them in a type-safe way.
 */
export const RD_GATE_IDS = [
  "matrix-source-or-deferred",
  "hub-vault-source",
  "agent-msg-source-or-deferred",
  "stale-source-confidence",
  "find-tools-self-hosting",
  "find-tools-narrow-result",
  "fetch-context-three-line-ergonomics",
] as const;

export type GateId = (typeof RD_GATE_IDS)[number];

export type GateOutcome = "pass" | "fail" | "deferred";

/**
 * One gate's outcome plus a short human-readable explanation. `detail` is
 * optional on PASS but required on FAIL and DEFER so the operator always
 * sees why a gate didn't move to PASS.
 */
export interface GateResult {
  id: GateId;
  title: string;
  outcome: GateOutcome;
  detail?: string;
}

/**
 * Aggregated report returned by {@link runReadinessGates}.
 */
export interface GateReport {
  results: GateResult[];
  summary: {
    passed: number;
    failed: number;
    deferred: number;
  };
}

/**
 * Options for {@link runReadinessGates}. Defaults to running against the
 * caller's own workspace + the canonical hub root, which is the right
 * behavior when a human runs `/gates` interactively. Tests pass fixture
 * roots so the gate behavior is reproducible.
 */
export interface GateRunOptions {
  workspaceRoot: string;
  hubRoot: string;
  /** Free-text query used by gates 1, 2, 3 to probe the primitives. */
  probeQuery?: string;
  /** Tool query for gate 5 (self-hosting proof). */
  selfHostingQuery?: string;
  /** Tool query for gate 6 (narrow-result proof). */
  narrowResultQuery?: string;
  /** Test seam for deterministic timestamps. */
  now?: () => Date;
}

const DEFAULT_PROBE_QUERY = "memory rule about time estimates";
const DEFAULT_SELF_HOSTING_QUERY = "search hub for X";
const DEFAULT_NARROW_QUERY = "memory recall about prior decisions";

// Word-boundary-anchored markers for the stale-source-confidence gate.
// Using `\b…\b` rather than `String.prototype.includes` keeps:
//   - "stale" without flagging "stalemate" / "stalest" / "installed"
//   - "deprecated" without flagging "undeprecated" / "deprecation"
//   - "supersed" anchored at a word start so it matches "supersedes" /
//     "superseded" / "supersession" / "superseding" without flagging
//     internal substrings like "asuperseded" (no word boundary on the right
//     because the suffix varies). The `i` flag handles case.
const STALE_SOURCE_MARKER = /\bstale\b|\bdeprecated\b|\bsupersed/i;

/**
 * Execute every gate in {@link RD_GATE_IDS} order and assemble a
 * {@link GateReport}.
 *
 * The function is exception-safe: any throw inside a gate is captured and
 * surfaced as `outcome: "fail"` with the error message in `detail`, so a
 * single broken gate never short-circuits the rest of the report.
 */
export async function runReadinessGates(options: GateRunOptions): Promise<GateReport> {
  const results: GateResult[] = [];
  for (const id of RD_GATE_IDS) {
    try {
      // biome-ignore lint/style/noNonNullAssertion: id is one of RD_GATE_IDS literals
      const gate = GATES[id]!;
      const result = await gate(options);
      results.push(result);
    } catch (err) {
      results.push({
        id,
        title: GATE_TITLES[id],
        outcome: "fail",
        detail: `gate threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const summary = {
    passed: results.filter((r) => r.outcome === "pass").length,
    failed: results.filter((r) => r.outcome === "fail").length,
    deferred: results.filter((r) => r.outcome === "deferred").length,
  };
  return { results, summary };
}

const GATE_TITLES: Record<GateId, string> = {
  "matrix-source-or-deferred":
    "fetchContext returns Matrix source_ref OR signals not-yet-implemented",
  "hub-vault-source": "fetchContext returns absolute path for hub-vault matches",
  "agent-msg-source-or-deferred":
    "fetchContext returns agent-msg ref OR signals not-yet-implemented",
  "stale-source-confidence": 'Stale sources are labeled confidence="supporting", not "responsible"',
  "find-tools-self-hosting": 'findTools("search hub for X") returns searchDocs (self-hosting)',
  "find-tools-narrow-result": "findTools returns 1-3 tools, not the whole registry",
  "fetch-context-three-line-ergonomics":
    "fetchContext callable in three lines without further setup",
};

type GateFn = (opts: GateRunOptions) => Promise<GateResult>;

const GATES: Record<GateId, GateFn> = {
  "matrix-source-or-deferred": async (opts) => {
    const id: GateId = "matrix-source-or-deferred";
    const result = await fetchContext(opts.probeQuery ?? DEFAULT_PROBE_QUERY, {
      workspaceRoot: opts.workspaceRoot,
      hubRoot: opts.hubRoot,
      now: opts.now,
    });
    const matrixSource = result.sources.find((s) => s.source_type === "matrix");
    if (matrixSource) {
      const ref = matrixSource.source_ref;
      if (typeof ref === "string" && /^\$/.test(ref)) {
        return {
          id,
          title: GATE_TITLES[id],
          outcome: "pass",
          detail: `Matrix source surfaced with event-id ref ${ref}`,
        };
      }
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "fail",
        detail: `Matrix source present but source_ref is not a Matrix event id (got: ${ref})`,
      };
    }
    // No Matrix source surfaced. The trial agent treats this as DEFERRED
    // rather than PASS or FAIL because D's first commit deliberately left
    // searchRoomHistory unwired. The gate auto-tightens once a Matrix
    // primitive lands and starts populating result.sources.
    return {
      id,
      title: GATE_TITLES[id],
      outcome: "deferred",
      detail:
        "No source_type='matrix' in fetchContext result. searchRoomHistory not yet wired in @agents-js/tools (D follow-on). Gate will tighten to PASS-required once the primitive lands.",
    };
  },

  "hub-vault-source": async (opts) => {
    const id: GateId = "hub-vault-source";
    const result = await fetchContext(opts.probeQuery ?? DEFAULT_PROBE_QUERY, {
      workspaceRoot: opts.workspaceRoot,
      hubRoot: opts.hubRoot,
      now: opts.now,
    });
    const hubFile = result.sources.find(
      (s) =>
        s.source_type === "hub-file" &&
        typeof s.source_ref === "string" &&
        s.source_ref.startsWith("/"),
    );
    if (hubFile) {
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "pass",
        detail: `hub-file source returned absolute path: ${hubFile.source_ref}`,
      };
    }
    if (result.sources.some((s) => s.source_type === "hub-file")) {
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "fail",
        detail:
          "hub-file source returned but source_ref was not absolute. Primitive must emit absolute paths.",
      };
    }
    return {
      id,
      title: GATE_TITLES[id],
      outcome: "fail",
      detail: `No hub-file source in fetchContext result for query "${opts.probeQuery ?? DEFAULT_PROBE_QUERY}". Either the probe query found no matches under the configured roots (workspaceRoot=${opts.workspaceRoot}, hubRoot=${opts.hubRoot}) or the primitive is not emitting hub-file sources.`,
    };
  },

  "agent-msg-source-or-deferred": async (opts) => {
    const id: GateId = "agent-msg-source-or-deferred";
    const result = await fetchContext(opts.probeQuery ?? DEFAULT_PROBE_QUERY, {
      workspaceRoot: opts.workspaceRoot,
      hubRoot: opts.hubRoot,
      now: opts.now,
    });
    const agentMsgSource = result.sources.find((s) => s.source_type === "agent-msg");
    if (agentMsgSource) {
      const ref = agentMsgSource.source_ref;
      if (typeof ref === "string" && ref.length > 0) {
        return {
          id,
          title: GATE_TITLES[id],
          outcome: "pass",
          detail: `agent-msg source surfaced with ref ${ref}`,
        };
      }
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "fail",
        detail:
          "agent-msg source present but source_ref is empty. Primitive must emit a mailbox id (and event id when available).",
      };
    }
    return {
      id,
      title: GATE_TITLES[id],
      outcome: "deferred",
      detail:
        "No source_type='agent-msg' in fetchContext result. searchAgentMsg not yet wired in @agents-js/tools (D follow-on). Gate will tighten to PASS-required once the primitive lands.",
    };
  },

  "stale-source-confidence": async (opts) => {
    const id: GateId = "stale-source-confidence";
    // The current fetchContext implementation marks every source as
    // confidence="responsible" (search-memories.ts + search-docs.ts). The
    // staleness-vs-responsibility distinction lives in the spec but D's
    // first commit hasn't wired the staleness signal yet. Until it does,
    // verify the invariant the *other* direction: nothing returns the
    // word "stale" while still being labeled "responsible".
    const result = await fetchContext(opts.probeQuery ?? DEFAULT_PROBE_QUERY, {
      workspaceRoot: opts.workspaceRoot,
      hubRoot: opts.hubRoot,
      now: opts.now,
    });
    const offenders: string[] = [];
    for (const snippet of result.snippets) {
      const src = result.sources[snippet.source_index];
      if (!src) continue;
      if (STALE_SOURCE_MARKER.test(snippet.text) && src.confidence === "responsible") {
        offenders.push(src.source_ref);
      }
    }
    if (offenders.length === 0) {
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "pass",
        detail:
          "No snippet labeled 'responsible' contained stale/deprecated/superseded markers in its text.",
      };
    }
    return {
      id,
      title: GATE_TITLES[id],
      outcome: "fail",
      detail: `${offenders.length} stale-looking snippet(s) labeled responsible: ${offenders.slice(0, 3).join(", ")}`,
    };
  },

  "find-tools-self-hosting": async (opts) => {
    const id: GateId = "find-tools-self-hosting";
    const tools = await findTools(opts.selfHostingQuery ?? DEFAULT_SELF_HOSTING_QUERY);
    const top = tools[0];
    if (top?.name === "searchDocs") {
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "pass",
        detail: `findTools("${opts.selfHostingQuery ?? DEFAULT_SELF_HOSTING_QUERY}") returned searchDocs as top match (self-hosting proof).`,
      };
    }
    const names = tools.map((t) => t.name).join(", ") || "(none)";
    return {
      id,
      title: GATE_TITLES[id],
      outcome: "fail",
      detail: `Expected searchDocs at top of findTools result, got: [${names}]`,
    };
  },

  "find-tools-narrow-result": async (opts) => {
    const id: GateId = "find-tools-narrow-result";
    const registrySize = defaultRegistry.list().length;
    const tools = await findTools(opts.narrowResultQuery ?? DEFAULT_NARROW_QUERY);
    if (tools.length === 0) {
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "fail",
        detail: `findTools returned 0 tools for "${opts.narrowResultQuery ?? DEFAULT_NARROW_QUERY}"; expected 1-3.`,
      };
    }
    if (tools.length > 3) {
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "fail",
        detail: `findTools returned ${tools.length} tools; cap is 3.`,
      };
    }
    if (tools.length === registrySize && registrySize > 3) {
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "fail",
        detail: `findTools returned the entire registry (${registrySize} tools); narrowing is not happening.`,
      };
    }
    return {
      id,
      title: GATE_TITLES[id],
      outcome: "pass",
      detail: `findTools returned ${tools.length} tool(s) (registry has ${registrySize} total); narrowing confirmed.`,
    };
  },

  "fetch-context-three-line-ergonomics": async (opts) => {
    const id: GateId = "fetch-context-three-line-ergonomics";
    // Three-line ergonomics test, executed inline:
    //   1. import { fetchContext } from "@agents-js/tools";
    //   2. const ctx = await fetchContext(query, { workspaceRoot, hubRoot });
    //   3. (read ctx.snippets / ctx.sources)
    // We pass the roots explicitly because the trial agent runs as a
    // subprocess where process.cwd() is the spawn cwd (not necessarily the
    // workspace root); the import + single call shape is what the gate
    // really cares about.
    const ctx = await fetchContext("Jens's rule on time estimates", {
      workspaceRoot: opts.workspaceRoot,
      hubRoot: opts.hubRoot,
      now: opts.now,
    });
    const ok =
      Array.isArray(ctx.snippets) &&
      Array.isArray(ctx.sources) &&
      typeof ctx.snippets.length === "number";
    if (!ok) {
      return {
        id,
        title: GATE_TITLES[id],
        outcome: "fail",
        detail:
          "fetchContext did not return the documented FetchContextResult shape ({ snippets: Snippet[]; sources: Source[] }).",
      };
    }
    return {
      id,
      title: GATE_TITLES[id],
      outcome: "pass",
      detail: `fetchContext returned ${ctx.snippets.length} snippet(s) / ${ctx.sources.length} source(s) from a single 3-line caller.`,
    };
  },
};
