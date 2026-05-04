/**
 * `@agents-js/trial-agent` — real-ACP isolation harness for `@agents-js/tools`.
 *
 * This package exists to validate that the {@link fetchContext} +
 * {@link findTools} primitives in `@agents-js/tools` work end-to-end through
 * an actual ACP wire (stdio, NDJSON, ACP v1) before any production agent is
 * given access to them. Per the first-cycle plan it is intentionally Option B
 * (a real subprocess agent) rather than an in-process unit-test harness — a
 * unit harness would mask protocol-layer mismatches that this package is
 * explicitly designed to catch.
 *
 * Two drive paths share the same code:
 *
 * 1. Interactive — `bun run @agents-js/cli acp --harness trial` spawns the
 *    `trial-agent` binary; the orchestrator can send arbitrary prompts and
 *    observe the responses ACP-side.
 * 2. Programmatic — {@link runReadinessGates} executes the seven D readiness
 *    gates from the first-cycle plan as assertions and returns a structured
 *    pass/fail report; the integration test in `tests/integration.test.ts`
 *    drives this path through a real spawned subprocess.
 *
 * Public exports are kept narrow on purpose: callers either run the binary
 * (most users) or import {@link createPromptHandler} / {@link runReadinessGates}
 * directly to embed the harness in their own test code.
 */

export {
  type CreateTrialAgentOptions,
  createTrialAgent,
  DEFAULT_TRIAL_AGENT_HUB_ROOT,
  TRIAL_AGENT_NAME,
  TRIAL_AGENT_VERSION,
} from "./acp-agent.ts";
export {
  classifyPromptIntent,
  createPromptHandler,
  formatGateReportAsText,
  type IntentDispatchResult,
  type PromptHandler,
  type PromptIntent,
} from "./prompt-handler.ts";
export {
  type GateOutcome,
  type GateReport,
  type GateResult,
  type GateRunOptions,
  RD_GATE_IDS,
  runReadinessGates,
} from "./readiness-gates.ts";
