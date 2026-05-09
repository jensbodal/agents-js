/**
 * Prompt-intent parser + dispatch surface for the trial agent.
 *
 * The trial agent recognizes three intents:
 *
 * - `fetch-context` — coordinator dispatch. Triggered when the prompt
 *   contains a phrase like "fetch context" / "find context" / "what do
 *   you know about" or starts with `/fetch`. The remainder of the prompt
 *   becomes the {@link fetchContext} query.
 * - `find-tools` — discovery dispatch. Triggered by "find tools" / "what
 *   tools" / `/tools`. The remainder becomes the {@link findTools} query.
 * - `run-gates` — readiness-gate run. Triggered by "run gates" / "run
 *   readiness" / `/gates`. Executes {@link runReadinessGates} and returns
 *   a human-readable report plus a structured outcomes array.
 *
 * Anything else is classified as `unknown` and dispatched to a help string
 * so a confused operator gets a usage hint instead of silence.
 *
 * Intent parsing is deliberately keyword-based and case-insensitive — this
 * is a real-ACP isolation harness, not an NLU surface. Mis-classified
 * prompts are a cheap operator-side fix (rephrase) and not worth a parser.
 */

import type { FetchContextResult, ToolDefinition } from "@agents-js/tools";
import { fetchContext, findTools } from "@agents-js/tools";
import { type GateReport, type GateRunOptions, runReadinessGates } from "./readiness-gates.ts";

/**
 * Discriminated union of recognized prompt intents.
 */
export type PromptIntent =
  | { kind: "fetch-context"; query: string }
  | { kind: "find-tools"; query: string }
  | { kind: "run-gates" }
  | { kind: "unknown"; raw: string };

/**
 * Result of dispatching one classified intent.
 *
 * Carries both a `text` rendering (for ACP `agent_message_chunk`) and a
 * `data` field with the structured payload that the integration test
 * inspects to verify the gate assertions pass.
 */
export interface IntentDispatchResult {
  intent: PromptIntent;
  text: string;
  data:
    | { kind: "fetch-context"; result: FetchContextResult }
    | { kind: "find-tools"; tools: ToolDefinition[] }
    | { kind: "run-gates"; report: GateReport }
    | { kind: "help"; message: string };
}

/**
 * Bound prompt handler returned by {@link createPromptHandler}. Captures
 * the workspace + hub roots once so the ACP server can call it with just
 * the raw prompt text per turn.
 */
export type PromptHandler = (rawPrompt: string) => Promise<IntentDispatchResult>;

/**
 * Prompt-classification trigger patterns. Regex (vs. `.startsWith()` /
 * `.includes()`) is appropriate here because each trigger captures the
 * payload group via `(.+)` and tolerates optional connective words
 * ("about" / "for" / "on") between the verb and the query — both jobs
 * a substring check cannot do without a hand-rolled tokenizer.
 */
const FETCH_TRIGGERS = [
  /^\s*\/fetch\s+(.*)$/i,
  /^\s*fetch\s+context(?:\s+about|\s+for|\s+on)?\s+(.+)$/i,
  /^\s*find\s+context(?:\s+about|\s+for|\s+on)?\s+(.+)$/i,
  /^\s*what\s+do\s+you\s+know\s+about\s+(.+)$/i,
];

/**
 * Find-tools trigger patterns. Same regex-vs-substring rationale as
 * `FETCH_TRIGGERS` above: each entry captures the query payload via
 * `(.+)` and tolerates optional connective words ("for" / "to" /
 * "about") plus the optional "are available" hedge — both jobs a
 * substring check cannot do without a hand-rolled tokenizer.
 */
const FIND_TOOLS_TRIGGERS = [
  /^\s*\/tools\s+(.*)$/i,
  /^\s*find\s+tools?\s+(?:for|to|about)?\s*(.+)$/i,
  /^\s*what\s+tools?\s+(?:are\s+available\s+)?(?:for|to|about)?\s*(.+)$/i,
];

/**
 * Run-gates trigger patterns. Same regex-vs-substring rationale, but
 * with no capture group: gates take no payload, so callers `.test()`
 * the prompt for a yes/no match rather than extracting a query.
 * Tolerates the optional article ("the") and qualifier ("readiness")
 * that a `.startsWith()` check would over-narrow.
 */
const RUN_GATES_TRIGGERS = [
  /^\s*\/gates\s*$/i,
  /^\s*run\s+(?:the\s+)?(?:readiness\s+)?gates?\s*$/i,
  /^\s*run\s+readiness\s*$/i,
];

/**
 * Classify a free-text prompt into one of the recognized {@link PromptIntent}
 * variants. Pure function — no I/O, deterministic, easy to unit-test.
 */
export function classifyPromptIntent(rawPrompt: string): PromptIntent {
  const prompt = rawPrompt.trim();
  for (const re of FETCH_TRIGGERS) {
    const match = re.exec(prompt);
    if (match?.[1]) return { kind: "fetch-context", query: match[1].trim() };
  }
  for (const re of FIND_TOOLS_TRIGGERS) {
    const match = re.exec(prompt);
    if (match?.[1]) return { kind: "find-tools", query: match[1].trim() };
  }
  for (const re of RUN_GATES_TRIGGERS) {
    if (re.test(prompt)) return { kind: "run-gates" };
  }
  return { kind: "unknown", raw: prompt };
}

const HELP_MESSAGE = [
  "trial-agent — real-ACP harness for @agents-js/tools.",
  "",
  "Try one of:",
  "  fetch context about <topic>      — runs fetchContext, returns snippets + sources",
  "  /fetch <topic>                   — same as above, shorthand",
  "  find tools for <query>           — runs findTools, returns the narrow tool list",
  "  /tools <query>                   — same as above, shorthand",
  "  run gates                        — executes the 7 D readiness gates and reports",
  "  /gates                           — same as above, shorthand",
].join("\n");

/**
 * Build a bound {@link PromptHandler}. The returned closure carries the
 * workspace + hub roots that primitive dispatch needs, so the ACP server
 * loop only has to forward the raw text.
 *
 * `gateOptions` exists so the integration test can point gates at fixture
 * directories rather than the operator's actual workspace.
 */
export function createPromptHandler(opts: {
  workspaceRoot: string;
  hubRoot: string;
  gateOptions?: GateRunOptions;
  /** Test seam — overridden by tests to make timestamps deterministic. */
  now?: () => Date;
}): PromptHandler {
  return async function handle(rawPrompt: string): Promise<IntentDispatchResult> {
    const intent = classifyPromptIntent(rawPrompt);
    switch (intent.kind) {
      case "fetch-context": {
        const result = await fetchContext(intent.query, {
          workspaceRoot: opts.workspaceRoot,
          hubRoot: opts.hubRoot,
          now: opts.now,
        });
        return {
          intent,
          text: renderFetchContext(intent.query, result),
          data: { kind: "fetch-context", result },
        };
      }
      case "find-tools": {
        const tools = await findTools(intent.query);
        return {
          intent,
          text: renderFindTools(intent.query, tools),
          data: { kind: "find-tools", tools },
        };
      }
      case "run-gates": {
        const report = await runReadinessGates({
          workspaceRoot: opts.workspaceRoot,
          hubRoot: opts.hubRoot,
          ...opts.gateOptions,
        });
        return {
          intent,
          text: formatGateReportAsText(report),
          data: { kind: "run-gates", report },
        };
      }
      case "unknown":
        return {
          intent,
          text: HELP_MESSAGE,
          data: { kind: "help", message: HELP_MESSAGE },
        };
    }
  };
}

function renderFetchContext(query: string, result: FetchContextResult): string {
  const lines: string[] = [];
  lines.push(
    `fetchContext("${query}") - ${result.snippets.length} snippet(s) across ${result.sources.length} source(s)`,
  );
  if (result.snippets.length === 0) {
    lines.push("(no matches)");
    return lines.join("\n");
  }
  for (const snippet of result.snippets) {
    const src = result.sources[snippet.source_index];
    const ref = src ? `${src.source_type}:${src.source_ref}` : "(unknown source)";
    const conf = src ? ` [${src.confidence}]` : "";
    lines.push("");
    lines.push(`- ${ref}${conf} (score=${snippet.score.toFixed(3)})`);
    lines.push(snippet.text);
  }
  return lines.join("\n");
}

function renderFindTools(query: string, tools: ToolDefinition[]): string {
  const lines: string[] = [];
  lines.push(`findTools("${query}") - ${tools.length} match(es)`);
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
  }
  if (tools.length === 0) {
    lines.push("(no tools matched)");
  }
  return lines.join("\n");
}

/**
 * Render a {@link GateReport} as a human-readable text block. Used by both
 * the ACP `agent_message_chunk` payload and the integration test's
 * diagnostic output on failure.
 */
export function formatGateReportAsText(report: GateReport): string {
  const lines: string[] = [];
  lines.push(
    `Readiness gates - ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.deferred} deferred (${report.results.length} total)`,
  );
  for (const r of report.results) {
    const marker = r.outcome === "pass" ? "PASS" : r.outcome === "fail" ? "FAIL" : "DEFER";
    lines.push(`  [${marker}] ${r.id} - ${r.title}`);
    if (r.detail) lines.push(`         ${r.detail}`);
  }
  return lines.join("\n");
}
