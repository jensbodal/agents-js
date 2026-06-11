# @agents-js/policy

> Stateless permission policy evaluation for ACP hosts. Pure functions with no framework dependencies.

## Installation

```sh
bun add @agents-js/policy
```

## API

<!-- Auto-generated from JSDoc -->

### Functions

- **`applyReviewerAdvisory`** — Fold a read-only reviewer's advisory into a FROZEN guard evaluation. Monotonicity invariant (design packet §3): the only effect the reviewer can have is to raise `humanReviewRequired`. It cannot mo...
- **`assertNever`** — Exhaustive-switch helper. Use as the `default:` arm of a switch over a discriminated union to force a typecheck error when a new variant is added without a corresponding case. Throws at runtime if ...
- **`classifyOperation`** — Classify the operation type from a permission request. Uses heuristics on the tool name to determine the operation class. Includes workspace-specific operations (workspace.search, workspace.command...
- **`closestParentFolder`** — Return the closest parent folder for a workspace-relative file path. Examples: - `closestParentFolder("projects/daily/note.md")` → `"projects/daily"` - `closestParentFolder("note.md")` → `""` (root...
- **`createPermissionRule`** — Create a permission rule from a request and user choice.
- **`createRememberedRule`** — Create a remembered rule from a permission request and response. Returns null for "once" lifetime (once-rules are not remembered).
- **`describeOperationClass`** — Host-agnostic verb phrase for a canonical operation class. For unknown classes (including the `tool.<name>` fallback emitted by {classifyOperation} for unrecognised tool titles), falls back to the ...
- **`describeReplayScope`** — Build the human-readable "replay will match X" copy for a permission request. Derives operation class + resource scope via {classifyOperation} / {extractResourceScope} and pairs them with host-iden...
- **`erroredEvaluation`** — Build an `errored` verdict — the guard could not run; fails closed to full-lane.
- **`evaluateDocsOnlyGuard`** — Evaluate the docs-only guard over a changed-file list. Pure and deterministic. Empty diff → `not-proven` (nothing to prove) → full-lane. Caller wraps diff acquisition; on diff/policy failure use {e...
- **`evaluatePermissionRules`** — Evaluate a permission request against stored rules. Returns both the match result and a new array of rules with expired entries removed and consumed once-rules marked. The input array is not mutated.
- **`evaluateWriteGate`** — Evaluates whether a write operation should be reviewed or blocked. Outside-workspace paths are blocked. Everything else goes to review (never auto-approved). Cross-platform: handles both POSIX and ...
- **`extractResourceScope`** — Extract the resource scope from a permission request. Looks for common path-like arguments or command names.
- **`extractShellCommandPathArgs`** — Extract path-like arguments from a shell-command permission request for workspace-boundary checking. Prefers structured `args` in `rawInput`; falls back to parsing `toolCall.title` for terminal-sty...
- **`filterConsumedOnceRules`** — Remove consumed once-rules.
- **`filterExpiredRules`** — Remove expired rules.
- **`filterSessionRules`** — Filter to persistent rules only (removes session and once rules).
- **`generateScopeCandidates`** — Generate an ordered list of scope candidates for a permission scope selection UI. Given an extracted resource scope (from {extractResourceScope}), produces candidates from most specific (exact file...
- **`generateUnifiedDiff`** — Generates a simple unified diff between two strings. No external dependencies -- implements a basic line-based LCS diff.
- **`globToRegExp`** — Translate an explicit guard pattern to an anchored RegExp. Supported forms (see `docs-only-policy.ts`): `dir/**`, `**​/seg/**`, `*.ext`, `dir/**​/*.ext`, and exact paths. `*` matches within a singl...
- **`isDocsContent`** — Is this changed file documentation *content* (vs infrastructure)? The predicate every file must satisfy for the docs-only lane to be proven.
- **`isHighRisk`** — Check if an operation is high-risk and should never match remembered rules.
- **`isKnownDispatchFailureKind`** — Narrow an arbitrary string to {DispatchFailureKind} via set membership.
- **`isKnownOperationClass`** — Narrow an arbitrary string to {OperationClass} via set membership.
- **`isKnownReviewerTag`**
- **`isReadOnly`** — Returns true if the given operation class represents a read-only operation that is safe to auto-approve without user confirmation.
- **`isSensitive`** — Deterministic security-sensitive check (additive escalation, §4.5).
- **`isWithinDirectory`** — Check whether a candidate path is equal to or nested within a target directory. Both paths are workspace-relative (not absolute). Examples: - `isWithinDirectory("hub/acp", "hub/acp/file.md")` → tru...
- **`isWithinWorkspace`** — Check whether a candidate path is equal to or within a workspace root. Handles both POSIX and Windows paths automatically. Resolves relative segments (`.`, `..`) and normalizes case on Windows befo...
- **`policyError`** — Error for a policy violation -- the request is structurally valid but blocked by policy. Uses the reserved server-error range rather than `-32600`, which is reserved for malformed JSON-RPC requests.
- **`scopeMatches`** — Check if a rule's resource scope matches the request's resource scope. IMPORTANT: This performs raw string prefix matching. Callers must normalize paths (resolve `..` and `.` segments) before stori...
- **`toGuardResult`** — Map an internal guard evaluation onto the shared `DocsOnlyGuardResult` seam. Pure field rename — no decision logic. `guard_authoritative` is the guard's literal `true`: the bundle copies it but nev...
- **`usesWindowsPaths`** — Detect whether any of the provided path strings use Windows path conventions. Returns true if any value starts with a drive letter (C:\) or contains backslashes.
- **`validateTerminalRequest`** — Validates a CreateTerminalRequest against the direct-exec-only policy. Rules: 1. command must be a non-empty string 2. command must not be a shell wrapper 3. command must not contain path separator...
- **`validationError`** — Error for a validation failure -- the request parameters are invalid.

### Interfaces

- **`ChangedFile`** — A single changed file in a `base..head` diff (the guard's only input).
- **`DocsOnlyPolicy`** — A versioned set of deterministic path rules.
- **`GuardEvaluation`** — Internal evaluation result (NOT the shared seam type).
- **`PermissionEvaluationResult`** — Result of evaluating permission rules, including any mutations (expired rules removed, once-rules marked consumed). Hosts decide whether to apply the updated rules.
- **`PermissionRule`** — Scoped permission rule schema. Rules are scoped by agent identity, workspace, operation class, and resource scope. High-risk operations (shell execution, broad edits) are excluded from matching.
- **`PolicyErrorInfo`** — Error helpers for ACP policy decisions. Returns code + message pairs that hosts can pass to `new RequestError(code, message)` from /sdk.
- **`ReplayScopeDescription`**
- **`ReplayScopeLabels`** — Host-identity labels plugged into {describeReplayScope} output copy. - `hostLabel` replaces the subject of the replay sentence (e.g. "Obsidian", "VS Code", "this host"). - `resourceLabel` names the...
- **`ReviewerAdvisory`** — The advisory output of the read-only code-reviewer bundle — the INPUT to this boundary (not a shared seam type). Note the deliberate absence of any pass/fail/block/merge field: the reviewer cannot ...
- **`ReviewerBoundedDecision`** — The bounded outcome after folding a reviewer advisory into a guard verdict.
- **`RuleMatchResult`**
- **`ScopeCandidate`** — A candidate scope that can be presented to the user for selection.

### Types

- **`DispatchFailureKind`** — Discriminated union covering every reason a dispatch can fail. Two source layers, one shape — single source of truth so the permission layer ({import("-js/acp-host").evaluatePermission}) and the fu...
- **`DispatchFailureReason`** — Discriminated union shape carried on `MatrixBusReplyPayload.failureReason` and any other dispatch-result carrier. Permission kinds carry `operationClass`; transport kinds carry an optional `message...
- **`M1ReviewerTag`**
- **`OperationClass`** — Canonical, typed union of every operation class that {import("./permission-engine.ts").classifyOperation} can emit, excluding the open-ended `tool.<name>` fallback. Single source of truth for downs...
- **`RememberedLifetime`** — Lifetime of a remembered permission rule.
- **`ScopeLevel`** — Granularity level for a permission scope candidate.
- **`TerminalValidationResult`**
- **`WriteGateDecision`**

### Constants

- **`DOCS_ONLY_POLICY_V0`** — The M1 default policy. Versioned in-repo (git is the version control); the guard accepts an explicit policy override for tests and future iterations. Pattern syntax (see {matchesPattern}): - `dir/*...
- **`HIGH_RISK_OPERATIONS`** — Operation classes that can never be matched by remembered rules. Includes terminal operations, file deletion, and workspace command execution due to their potential for destructive or irreversible ...
- **`KNOWN_DISPATCH_FAILURE_KINDS`** — Canonical set of dispatch-failure-kind strings, derived from {KNOWN_DISPATCH_FAILURE_KINDS_RECORD} so adding a kind to {DispatchFailureKind} forces this set to widen in lockstep.
- **`KNOWN_OPERATION_CLASSES`** — Canonical set of operation-class strings emitted by {import("./permission-engine.ts").classifyOperation}, derived from {KNOWN_OPERATION_CLASSES_RECORD} so adding a class to {OperationClass} forces ...
- **`M1_REVIEWER_TAGS`** — Narrowed M1 reviewer tag vocabulary (design packet §5; addendum tag set).
- **`READ_ONLY_SHELL_COMMANDS`** — Read-only shell commands grouped by intent category. When a terminal/tool invocation's command word matches an entry here, `classifyOperation` returns the corresponding `workspace.shell.<category>`...
- **`READ_OPERATIONS`** — Operation classes that are always safe to auto-approve. These represent read-only or navigational operations with no side effects. Note: `workspace.shell.*` classes are deliberately NOT in this set...
- **`SHELL_COMMANDS`** — Commands that are always considered shell wrappers. Used by both the permission high-risk check and the terminal validation policy.
- **`WORKSPACE_SHELL_OPERATIONS`** — Operation classes produced by the read-only shell-command branch of `classifyOperation`.

### Exports

- **`type DocsOnlyPolicy`**
- **`type OperationClass`**
- **`type PolicyErrorInfo`**


## Dependencies

- `@agentclientprotocol/sdk`
- `@agents-js/schema-utils`
- `@agents-js/shell-args`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
