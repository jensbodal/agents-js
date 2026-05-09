/**
 * Write-gate approval logic extracted from ACPSessionController.
 *
 * Handles auto-approval for hub directories and writable folders,
 * and falls through to the UI modal for everything else.
 */
import { closestParentFolder, isWithinDirectory } from "@agents-js/policy";
import type { Logger } from "./logger.ts";
import type { ACPSessionEvent, ACPSessionState, WriteGateResolution } from "./types/session.ts";

/**
 * Determine whether a write should be auto-approved or requires a UI modal.
 *
 * Returns a resolved `Promise<boolean>` for auto-approved writes, or
 * creates a pending write gate on `state` and emits the request event.
 */
export function requestWriteGateApproval(
  gate: { path: string; diff: string; absolutePath?: string },
  state: ACPSessionState,
  hubDirectoryPath: string | null,
  writableFolders: Iterable<string>,
  sessionWritableFolders: Set<string>,
  emit: (event: ACPSessionEvent) => void,
  log: Logger,
): Promise<boolean> {
  // Auto-approve writes to the hub directory
  if (hubDirectoryPath && isWithinDirectory(hubDirectoryPath, gate.path)) {
    log.info("Write auto-approved (hub directory)", { path: gate.path });
    return Promise.resolve(true);
  }

  // Auto-approve writes to configured or session-added writable folders
  const allWritable = [...writableFolders, ...sessionWritableFolders];
  for (const folder of allWritable) {
    if (isWithinDirectory(folder, gate.path)) {
      log.info("Write auto-approved (writable folder)", { path: gate.path, folder });
      return Promise.resolve(true);
    }
  }

  // Falls through to modal -- compute closest parent for the "Allow folder" button
  const parentFolder = closestParentFolder(gate.path);

  return new Promise<boolean>((resolve) => {
    state.pendingWriteGate = {
      ...gate,
      closestParentFolder: parentFolder,
      resolve: (result: WriteGateResolution) => {
        if (result.action === "allow_folder") {
          const folder = result.folder;
          // Validate: non-empty, no traversal segments, must be a plausible
          // workspace-identity-relative path.
          if (!folder || folder.includes("..") || folder.startsWith("/")) {
            log.warn("Invalid allow_folder path rejected", { folder });
            resolve(false);
            return;
          }
          sessionWritableFolders.add(folder);
          emit({ type: "writable_folder_added", folder });
          resolve(true);
        } else {
          resolve(result.action === "approve");
        }
      },
    };
    emit({
      type: "write_gate_requested",
      path: gate.path,
      diff: gate.diff,
      closestParentFolder: parentFolder,
    });
  });
}
