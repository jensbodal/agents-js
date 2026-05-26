import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { classifyOperation, extractResourceScope } from "./permission-engine.ts";
import {
  assertNever,
  isKnownOperationClass,
  KNOWN_OPERATION_CLASSES,
  type KnownOperationClass,
  type OperationClass,
} from "./permission-types.ts";

// Re-export the canonical union from the single source of truth so existing
// consumers importing from `./describe-permission.ts` keep working without
// chasing the symbol to a new module.
export { KNOWN_OPERATION_CLASSES, type KnownOperationClass };

function quote(value: string): string {
  return `\u201C${value}\u201D`;
}

/**
 * Host-agnostic verb phrase for a canonical operation class.
 *
 * For unknown classes (including the `tool.<name>` fallback emitted by
 * {@link classifyOperation} for unrecognised tool titles), falls back to the
 * quoted tool title if present, otherwise to a generic phrase.
 */
export function describeOperationClass(
  operationClass: string,
  request: RequestPermissionRequest,
): string {
  if (isKnownOperationClass(operationClass)) {
    const narrowed: OperationClass = operationClass;
    switch (narrowed) {
      case "file.read":
        return "read this file";
      case "file.write":
        return "write this file";
      case "file.delete":
        return "delete this file";
      case "terminal.create":
        return "run this command";
      case "workspace.search":
        return "run this workspace search";
      case "workspace.command.execute":
        return "run this workspace command";
      case "workspace.command.list":
        return "list workspace commands";
      case "workspace.data-query":
        return "run this data query";
      case "workspace.navigate":
        return "navigate in the workspace";
      case "workspace.shell.read":
        return "read this file via shell";
      case "workspace.shell.search":
        return "search this folder via shell";
      case "workspace.shell.list":
        return "list this folder via shell";
      default:
        return assertNever(narrowed);
    }
  }
  const title = request.toolCall?.title;
  if (title) {
    return `run ${quote(title)}`;
  }
  return "run this tool request";
}

/**
 * Host-identity labels plugged into {@link describeReplayScope} output copy.
 *
 * - `hostLabel` replaces the subject of the replay sentence (e.g. "Obsidian",
 *   "VS Code", "this host").
 * - `resourceLabel` names the enclosing resource collection (e.g. "this vault",
 *   "this workspace", "this repository").
 *
 * Both should be grammatically usable as subjects/objects in English prose.
 */
export interface ReplayScopeLabels {
  hostLabel: string;
  resourceLabel: string;
}

export interface ReplayScopeDescription {
  summary: string;
  detail: string;
}

/**
 * Build the human-readable "replay will match X" copy for a permission request.
 *
 * Derives operation class + resource scope via {@link classifyOperation} /
 * {@link extractResourceScope} and pairs them with host-identity labels to
 * produce two strings: a `summary` for inline presentation next to the replay
 * lifetime control, and a `detail` explaining where the scope came from.
 */
export function describeReplayScope(
  request: RequestPermissionRequest,
  labels: ReplayScopeLabels,
): ReplayScopeDescription {
  const operationClass = classifyOperation(request);
  const resourceScope = extractResourceScope(request);
  const requestLabel = request.toolCall?.title ?? "this request";
  const operationDescription = describeOperationClass(operationClass, request);
  const { hostLabel, resourceLabel } = labels;

  if (resourceScope === "*") {
    return {
      summary: `If you replay this choice for this session or across sessions, ${hostLabel} will reuse it when the agent tries to ${operationDescription} in ${resourceLabel}.`,
      detail: `This request does not expose a file, folder, command, or domain scope. Replay is keyed to the request label ${quote(requestLabel)}, not a domain-wide or folder-wide rule.`,
    };
  }

  if (resourceScope.startsWith("cmd:")) {
    const command = resourceScope.slice(4);
    return {
      summary: `If you replay this choice for this session or across sessions, ${hostLabel} will reuse it for command ${quote(command)} in ${resourceLabel}.`,
      detail: `Replay scope comes from the command field on this request.`,
    };
  }

  return {
    summary: `If you replay this choice for this session or across sessions, ${hostLabel} will reuse it for ${operationDescription} at ${quote(resourceScope)} in ${resourceLabel}.`,
    detail: `Replay scope comes from the request path ${quote(resourceScope)}.`,
  };
}
