import type { HostSurfaceAdapter } from "@agents-js/a2ui-host/acp-host";
import { createNodeFileAdapters, type PermissionMode } from "@agents-js/acp-host";
import {
  createStandaloneHostController,
  type GatewayHostController,
  type HarnessFleetEntry,
  type HostSession,
} from "@agents-js/host";

/**
 * Dependencies for building a lane-controller factory.
 *
 * The factory body intentionally reads `permissionEngine` and
 * `permissionStore` from the SHARED `HostSession` reference rather
 * than constructing per-call. This preserves the AJS-7 PR2 invariant
 * (multi-harness coexistence reuses the process-wide permission
 * surface). Extracting the factory into a pure builder makes that
 * invariant directly testable — `lane-controller-factory.test.ts`
 * asserts identity preservation across factory invocations without
 * standing up the full `main()` composition.
 */
export interface LaneControllerFactoryDeps {
  session: HostSession;
  workspacePath: string;
  permissionMode: PermissionMode;
  defaultModel?: string;
  surfaceAdapter?: HostSurfaceAdapter;
  /**
   * Host-controller constructor; defaults to `createStandaloneHostController`.
   * Exposed for tests that need to capture call arguments without spawning
   * a real ACP child.
   */
  createController?: typeof createStandaloneHostController;
}

export function buildLaneControllerFactory(
  deps: LaneControllerFactoryDeps,
): (entry: HarnessFleetEntry) => Promise<GatewayHostController> {
  const create = deps.createController ?? createStandaloneHostController;
  return async (entry: HarnessFleetEntry) =>
    create({
      runtime: entry.runtime,
      workspacePath: deps.workspacePath,
      permissionMode: deps.permissionMode,
      defaultModel: deps.defaultModel,
      permissionEngine: deps.session.permissionEngine,
      permissionStore: deps.session.permissionStore,
      fileAdapters: createNodeFileAdapters(deps.workspacePath),
      ...(deps.surfaceAdapter ? { surfaceAdapter: deps.surfaceAdapter } : {}),
    });
}
