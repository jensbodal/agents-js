# ADR 0001: Host-Orchestrated Planner/Generator/Evaluator Harness

**Date:** 2026-04-20  
**Status:** Proposed  
**Author:** Jens Bodal  

---

## Context

Long-horizon agent work requires managing multiple context windows without losing state or introducing self-leniency bias. Anthropic's recent planner–generator–evaluator pattern demonstrates that:

1. **Explicit session structure** across distinct roles improves reliability and debuggability.
2. **File-based communication** between roles avoids protocol coupling and enables clean session boundaries.
3. **Evaluator separation** mitigates the model's tendency to judge its own work too leniently; a dedicated evaluator with hard thresholds can apply skeptical grading independently.
4. **Automatic compaction** alone is insufficient—explicit artifacts (product spec, feature list, progress records) preserve continuity and enable fresh session pickup.

agents-js has the tooling (ACPSessionController, workspace isolation, file-based adapters) to port this pattern faithfully. However, the repo's architecture is explicit: orchestration lives in the **host layer** (`@agents-js/acp-host`, `@agents-js/policy`), not in transport protocols. The A2A layer is for **distribution** (optional); the harness is for **orchestration** (required).

**Relevant compaction behavior:** Token compaction can reduce context cost, but evaluators operating under compaction may become leniently self-scoring if they have never seen the uncompacted conversation history. Separating the evaluator and arming it with hard rubric thresholds and explicit test output closes this gap.

**Status of supporting packages:**  
- `@agents-js/acp` and `@agents-js/acp-host`: RC  
- `@agents-js/a2a`, `@agents-js/a2a-client`, `@agents-js/cli`: Preview

This justifies Phase 1's host-first conservatism.

---

## Decision

We will implement a **host-orchestrated, file-communicating harness** with three distinct roles:

### 1. Orchestrator Core

Built on `ACPSessionController`, the host orchestrator owns:
- **Session lifecycle** for planner, generator, and evaluator
- **Budget and retry logic** per role
- **Workspace isolation** (separate cwd, identity paths, read/write roots per role)
- **File I/O contracts** (writing/reading the six canonical files)
- **Hard rubric thresholds** and pass/fail criteria
- **Optional A2A exposure** for future distribution (Phase 2)

### 2. Three Role Sessions

#### Planner Session
- **Permissions:** Read-mostly workspace (product requirements, feature templates)
- **Output:** `product-spec.json` (product shape, success criteria) + `feature-list.json` (prioritized, decomposed features)
- **Runtime profile:** `plan` (limited tools: file read, product reasoning, LLM inference)
- **Isolation:** Separate `sessionCwd` in a scratch workspace
- **Compaction:** Allowed; planner is stateless between invocations

#### Generator Session
- **Permissions:** Full read/write source access, git, build/test toolchain
- **Isolation:** Separate `sessionCwd`, `workspaceIdentityPath`, explicit `approvedWriteRoots` scoped to feature branches
- **Workflow:** Operates **one sprint at a time**; leaves repo in clean state after each sprint
- **Output:** Git commits, updated source, `progress.jsonl` entries (one per completed task or error)
- **Runtime profile:** `dev` (full tooling: shell, git, build/test, file R/W, browser if needed)
- **Compaction:** Allowed; explicit progress.jsonl acts as continuation anchor

#### Evaluator Session
- **Permissions:** Read-only source by default + scratch output for test artifacts + browser tools (smoke/e2e)
- **Isolation:** Separate from generator; ideally separate `sessionCwd` + `approvedReadRoots` (source only, no write)
- **Output:** `eval-report.json` (per-criterion rubric scores, pass/fail, exit decision)
- **Runtime profile:** `eval` (limited tools: file read, shell test commands, browser smoke/e2e, report writing)
- **Rejection path:** Fails fast if any criterion scores below threshold; triggers generator retry or escalation
- **Compaction:** Allowed; evaluator ingests explicit artifacts (product spec, feature list, progress.jsonl) rather than full conversation

#### Optionality

The three roles above are a **composition pattern**, not a required scaffold. Each role is independent, and any subset is a valid harness configuration — a null role is a valid choice. For example:

- **Generator-only** — a summarizer or codemod harness where planning is implicit and evaluation is external (or human).
- **Planner + evaluator (no generator)** — a review or audit harness that analyzes existing artifacts without producing new code.
- **Planner + generator (no evaluator)** — exploratory prototyping where human review stands in for programmatic evaluation.

The three-role shape composes cleanly when all three are present, but harnesses should instantiate only the roles they need. Treat it as the ceiling of the pattern, not a floor.

### 3. File-Based Communication

Six canonical files mediate role handoff:

| File | Producer | Consumers | Format | Purpose |
|------|----------|-----------|--------|---------|
| `product-spec.json` | Planner | Generator, Evaluator | JSON | Product description, acceptance criteria, success metrics |
| `feature-list.json` | Planner | Generator, Evaluator | JSON | Ordered, prioritized feature list for sprint planning |
| `sprint-contract.json` | Orchestrator (pre-sprint) | Generator, Evaluator | JSON | Pre-sprint agreement: rubric, thresholds, scope, budget |
| `progress.jsonl` | Generator | Evaluator, Orchestrator | JSONL | Line-delimited progress entries (task start/end/error) |
| `eval-report.json` | Evaluator | Orchestrator | JSON | Rubric scores, per-criterion pass/fail, recommendation |
| `handoff.json` | Orchestrator | Planner (next session) | JSON | Between-session metadata (resume state, active sprint, session ID, commit range) |

### 4. Workspace & Permission Isolation

Each role session has:
- **`sessionCwd`:** Isolated working directory (temp or scoped)
- **`workspaceIdentityPath`:** Distinct identity file per role (enables audit trail)
- **`approvedReadRoots`:** Explicit list of readable paths (planner: product docs; evaluator: source + public tests)
- **`approvedWriteRoots`:** Explicit list of writable paths (generator: source + scratch; evaluator: scratch only)
- **`scratchRoots`:** Isolated scratch space for test artifacts, logs, temporary output
- **Runtime `--profile`:** Named profile (`plan`, `dev`, `eval`) with pre-configured tool set

### 5. Evaluator Browser Surface

For browser-driven testing (smoke tests, UI validation), the evaluator uses existing agents-js surfaces:
- **`bun run browser:smoke`** — deterministic, artifact-capturing validation
- **`bun run e2e:web:live -- --runtime <id>`** — real runtime + browser validation

These are repo-native building blocks, preferable to Playwright MCP for evaluator integration.

### 6. Phased Rollout

**Phase 1 (near-term):** Host-orchestrated within one process
- Orchestrator, planner, generator, evaluator run as **distinct ACPSessionController sessions** inside a single host
- All six files live on the local filesystem
- No remote distribution
- Intended scope: module-level PoC + reference implementation

**Phase 2 (optional, conditional):** A2A exposure
- Expose planner/generator/evaluator as **separate A2A agents** via `agents-js serve`
- Route inter-agent calls via `@@dispatch` or direct API
- Enables heterogeneous runtimes, separate compute, external integrations
- Deferred decision; only if Phase 1 proves the pattern

---

## Consequences

### Enables

1. **Clear separation of concerns:** Each role has bounded responsibilities, tooling, and permissions.
2. **Iterative sprint-based development:** Generator works in contained sprints; evaluator decides go/no-go per sprint.
3. **Evaluator skepticism:** Hard rubric thresholds + separate session reduce self-leniency bias.
4. **Debuggability:** File artifacts + distinct session IDs make it easy to trace decisions and replay.
5. **Future distribution:** Phase 2 can expose roles as A2A agents without rearchitecting the harness contract.

### Forecloses

1. **Tight coupling via shared context:** The harness relies on files, not context reuse, so shared model state is impossible (by design).
2. **Real-time streaming between roles:** Phase 1 uses batch file I/O; streaming integration deferred to Phase 2.
3. **Unified memory store:** The harness does NOT include a vector DB or persistent registry. Long-horizon memory is managed via explicit artifacts only.

### Maintenance Load

1. **File schema versioning:** Six JSON schemas must be maintained in lockstep. Changes to any schema require explicit ADR follow-ups.
2. **Isolation configuration:** Workspace paths, profiles, and permission sets add operational complexity; tooling must validate these at session start.
3. **Orchestrator lifecycle:** The host orchestrator becomes a permanent component; its test coverage and error handling must be rigorous.

---

## Alternatives Considered

### 1. A2A-as-Harness (Rejected)

**Claim:** Use A2A protocol itself as the orchestration layer.

**Why rejected:** A2A is a transport protocol, not an orchestrator. It enables agents to call tools and tasks on remote runtimes, but it does not define:
- Session lifecycle
- Workspace isolation
- Hard pass/fail rubrics
- File contracts
- Budget + retry logic

These are host-layer concerns. Building the harness into A2A would couple transport to orchestration and prevent the toolkit from supporting other harness patterns (e.g., multi-turn without file communication).

### 2. Single Session with Compaction (Rejected)

**Claim:** Run planner, generator, and evaluator in one continuous ACP session; rely on automatic compaction to stay within context.

**Why rejected:**
- Compacted evaluators lack uncompacted history and may become self-lenient.
- No clear session boundary between roles; makes debugging harder.
- Mixing permissions (planner read-mostly, generator full write, evaluator read-only) in one session adds operational complexity.

### 3. Full Turnkey Framework (Rejected)

**Claim:** Build a complete harness framework as a new package with built-in storage, registry, and workflow engine.

**Why rejected:** Violates the execution brief's "module-first" principle. The repo is in Preview/RC; committing to a new harness package would lock in API surfaces prematurely. Instead, the ADR defines a **reference pattern** that can be implemented as a module first, extracted to a package later if proven.

---

## Rollout

### Phase 1: Host-Orchestrated Within One Process (0–6 weeks)

**Goal:** Prove the planner/generator/evaluator pattern; establish file contracts.

**Scope:**
- Implement orchestrator as a module in `@agents-js/acp-host` (or adjacent package).
- Define and validate the six JSON schemas.
- Write planner, generator, evaluator as sample agent templates (not baked-in).
- Manual testing on a small feature-dev task (e.g., "add a CLI command").
- Document session setup, isolation config, and rubric tuning.

**Acceptance:**
- Planner produces valid `product-spec.json` + `feature-list.json`.
- Generator completes one sprint end-to-end; repo stays buildable.
- Evaluator reports pass/fail on explicit rubric; rejects broken sprints.
- Artifacts are readable and hand-editable for debugging.

### Phase 2: A2A Exposure (conditional, 6+ weeks)

**Goal:** Enable distributed deployment; separate compute/runtimes.

**Scope:**
- Expose planner, generator, evaluator as A2A agent entrypoints.
- Implement cross-agent messaging via `@@dispatch` or similar.
- Add streaming support for long evaluator runs.
- Test remote planner + local generator + remote evaluator.

**Decision point:** Only proceed if Phase 1 is stable AND there is demand for distributed orchestration.

---

## File Schemas

Five JSON schema files are defined in this ADR's schema directory: `docs/adrs/0001-schemas/`.

Each schema is JSON Schema draft-07 compatible and includes:
- **Required fields** (explicit `required` array)
- **Tight types** (no bare `string` if an enum or fixed set applies)
- **Brief field descriptions** (per-field `description`)
- **Examples** (where applicable)

### Schema Index

1. **`product-spec.schema.json`** — Planner output; describes the product, success criteria, and constraints.
2. **`feature-list.schema.json`** — Planner output; ordered, prioritized, decomposed feature set.
3. **`sprint-contract.schema.json`** — Orchestrator output (pre-sprint agreement); rubric, thresholds, scope, budget.
4. **`progress.schema.json`** — Generator output; JSONL entries tracking task completion, errors, and progress.
5. **`eval-report.schema.json`** — Evaluator output; rubric scores, per-criterion pass/fail decisions, and final recommendation.
6. **`handoff.schema.json`** — Orchestrator output; between-session metadata for resuming work.

For exact field definitions, see the corresponding `.schema.json` file.

---

## Open Questions

1. **Compaction budgets:** Should each role have a distinct compaction budget (e.g., planner 20% of context, evaluator 60%)? Or a global strategy?
   - Deferred to Phase 1 tuning.

2. **Retry semantics:** If a generator sprint fails evaluator thresholds, should the orchestrator automatically retry, escalate to a human, or offer both?
   - Recommend: Escalate by default in Phase 1; add automatic retry as an optional mode in Phase 1.5.

3. **Cross-sprint dependencies:** If feature N depends on feature M, and feature M fails in sprint T, how does the generator pick up features N, N+1, … in sprint T+1?
   - Recommend: Explicit dependency tracking in `feature-list.json`; orchestrator detects conflicts and adjusts the next sprint's scope.

4. **Evaluator tool inventory:** Should the evaluator have access to the same tools as the generator (e.g., full shell), or a curated subset?
   - Recommend: Curated subset (`run`, `test`, `browser smoke`) in Phase 1. Expand if needed.

5. **A2A routing:** If Phase 2 distributes roles across A2A agents, how do we handle failure/timeout in one agent affecting another's input?
   - Defer to Phase 2 decision point.

---

## References

- Anthropic Engineering Blog: [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Anthropic Engineering Blog: [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- agents-js architecture and host guide: `/docs/primitives.md`, `/docs/harness-guide.md`
- Execution Brief: `.agents/omd-orchestrator/execution-brief-agents-js-skills-integration-2026-04-20.md` §2.4
- Harness Research: `.agents/omd-orchestrator/harness-design-research-2026-04-20.md`
