// -- Describe-permission ------------------------------------------------------
export {
  describeOperationClass,
  describeReplayScope,
  KNOWN_OPERATION_CLASSES,
  type KnownOperationClass,
  type ReplayScopeDescription,
  type ReplayScopeLabels,
} from "./describe-permission.ts";
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
  HIGH_RISK_OPERATIONS,
  READ_OPERATIONS,
  SHELL_COMMANDS,
} from "./permission-types.ts";
export type { TerminalValidationResult } from "./terminal-policy.ts";
// -- Terminal policy ----------------------------------------------------------
export { validateTerminalRequest } from "./terminal-policy.ts";
// -- Write-gate policy --------------------------------------------------------
export {
  evaluateWriteGate,
  generateUnifiedDiff,
  type WriteGateDecision,
} from "./write-gate.ts";
