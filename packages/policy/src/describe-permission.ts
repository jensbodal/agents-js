import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { classifyOperation, extractResourceScope } from "./permission-engine.ts";

/**
 * Canonical set of operation-class strings emitted by {@link classifyOperation}.
 *
 * {@link describeOperationClass} is exhaustive against this union: adding a
 * branch to `classifyOperation` without extending `KNOWN_OPERATION_CLASSES`
 * produces a non-exhaustive-switch type error rather than silently degrading to
 * the fallback description. Host-side renderers that re-implemented this map
 * previously had no such defense and were the drift risk flagged by the
 * permission-UX audit (2026-04-17).
 */
export const KNOWN_OPERATION_CLASSES = [
  "file.read",
  "file.write",
  "file.delete",
  "terminal.create",
  "workspace.search",
  "workspace.command.execute",
  "workspace.command.list",
  "workspace.data-query",
  "workspace.navigate",
] as const;

export type KnownOperationClass = (typeof KNOWN_OPERATION_CLASSES)[number];

function isKnownOperationClass(value: string): value is KnownOperationClass {
  return (KNOWN_OPERATION_CLASSES as readonly string[]).includes(value);
}

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
    switch (operationClass) {
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
