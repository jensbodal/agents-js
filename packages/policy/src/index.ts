// -- Describe-permission ------------------------------------------------------
export {
  describeOperationClass,
  describeReplayScope,
  type ReplayScopeDescription,
  type ReplayScopeLabels,
} from "./describe-permission.ts";
// -- Docs-only guard-output adapter (M1 §4.7 seam) ----------------------------
export { toGuardResult } from "./docs-only-guard-result.ts";
export {
  type ChangedFile,
  erroredEvaluation,
  evaluateDocsOnlyGuard,
  type GuardEvaluation,
  globToRegExp,
  isDocsContent,
  isSensitive,
} from "./docs-only-path-guard.ts";
// -- Docs-only path guard (M1 item 3) -----------------------------------------
export { DOCS_ONLY_POLICY_V0, type DocsOnlyPolicy } from "./docs-only-policy.ts";
// -- Policy errors ------------------------------------------------------------
export { type PolicyErrorInfo, policyError, validationError } from "./errors.ts";
export {
  closestParentFolder,
  isWithinDirectory,
  isWithinWorkspace,
  usesWindowsPaths,
} from "./path-utils.ts";
// -- Permission engine --------------------------------------------------------
export {
  classifyOperation,
  createPermissionRule,
  createRememberedRule,
  evaluatePermissionRules,
  extractResourceScope,
  extractShellCommandPathArgs,
  filterConsumedOnceRules,
  filterExpiredRules,
  filterSessionRules,
  generateScopeCandidates,
  isHighRisk,
  isReadOnly,
  scopeMatches,
} from "./permission-engine.ts";
export type {
  PermissionEvaluationResult,
  PermissionRule,
  RememberedLifetime,
  RuleMatchResult,
  ScopeCandidate,
  ScopeLevel,
} from "./permission-types.ts";
// -- Permission types ---------------------------------------------------------
export {
  assertNever,
  type DispatchFailureKind,
  type DispatchFailureReason,
  HIGH_RISK_OPERATIONS,
  isKnownDispatchFailureKind,
  isKnownOperationClass,
  KNOWN_DISPATCH_FAILURE_KINDS,
  KNOWN_OPERATION_CLASSES,
  type OperationClass,
  READ_ONLY_SHELL_COMMANDS,
  READ_OPERATIONS,
  SHELL_COMMANDS,
  WORKSPACE_SHELL_OPERATIONS,
} from "./permission-types.ts";
// -- Read-only reviewer-bundle boundary (M1 item 4) ---------------------------
export {
  applyReviewerAdvisory,
  isKnownReviewerTag,
  M1_REVIEWER_TAGS,
  type M1ReviewerTag,
  type ReviewerAdvisory,
  type ReviewerBoundedDecision,
} from "./reviewer-bundle-boundary.ts";
export type { TerminalValidationResult } from "./terminal-policy.ts";
// -- Terminal policy ----------------------------------------------------------
export { validateTerminalRequest } from "./terminal-policy.ts";
// -- Write-gate policy --------------------------------------------------------
export {
  evaluateWriteGate,
  generateUnifiedDiff,
  type WriteGateDecision,
} from "./write-gate.ts";
