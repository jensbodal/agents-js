// Public scripting surface for `@agents-js/cli`. Only the symbols listed
// below are part of the published contract; internal helpers (parseArgv,
// consumeValue, inspectFirstChunk, ArgSpec, etc.) stay co-located with the
// modules that own them.
//
// gateway-runtime symbols are NOT re-exported here — consumers should import
// directly from `@agents-js/gateway-runtime` (a dependency of this package).
// Wildcard re-exports across package boundaries violate the "no wildcards
// across package boundaries" rule in the root CLAUDE.md.

export type { AcpChildProcess, AcpCommandArgs, AcpCommandDependencies } from "./acp.ts";
export {
  ACP_CONTAMINATION_EXIT_CODE,
  acpArgsToRuntimeEnvOverrides,
  parseAcpCommandArgs,
  runAcpCommand,
} from "./acp.ts";
export { runAgentsJsCli } from "./cli.ts";
export type { ContaminationResult } from "./contamination.ts";
export { formatContaminationError, inspectFirstChunk } from "./contamination.ts";
export type { SendCommandArgs, SendCommandDependencies } from "./send.ts";
export { parseSendCommandArgs, runSendCommand } from "./send.ts";
export type {
  PersistMode,
  ResolvedServeInputs,
  ServeCommandArgs,
  ServeCommandDependencies,
  ServeCommandResult,
} from "./serve.ts";
export { parseServeCommandArgs, runServeCommand, serveArgsToRuntimeEnvOverrides } from "./serve.ts";
export type { SkillCommandDependencies } from "./skill.ts";
export { resolvePackagedSkillPath, runSkillCommand } from "./skill.ts";
