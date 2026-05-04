import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  auditReleaseReadinessDefaults,
  RELEASE_READINESS_CHECKS,
} from "../scripts/release-preflight.ts";

const repoRoot = path.resolve(import.meta.dir, "..");

/**
 * Source-level regression guards must:
 *
 *   1. Pass on the current source tree (the "green" assertion that runs
 *      automatically as part of `bun run check`).
 *   2. Detect a regression when the guarded pattern is mutated. We
 *      simulate this by feeding each validator a deliberately-broken
 *      contents string and asserting it returns an issue.
 *
 * The mutation table below is hand-written so a future check authoring a
 * new regex still has to think about what regression looks like — there
 * is no clever auto-mutation here, on purpose.
 */
const MUTATIONS: Record<string, string> = {
  "no global baseline secret keys": `export const BASELINE_AGENT_SECRET_ENV_KEYS: readonly string[] = Object.freeze(["ANTHROPIC_API_KEY"]);`,
  "--registry-sync flag exists": `export function someOther() {}`,
  "registry sync gate respects only literal 'true'": `if (env.AGENTS_JS_REGISTRY_SYNC) return true;`,
  "internal gateway registry sync is gated by --registry-sync": `let registrySync = true; // always on, no flag`,
  "internal gateway does NOT call startRegistrySync unconditionally": `const registrySync = startRegistrySync({ name: "x", url: "y" });`,
  "--trust-workspace flag exists": `if (arg === "--something-else") { /* ... */ }`,
  "@@dispatch does not hard-code yolo and publishes cancelable=false": `await dispatchController.setPermissionMode("yolo");`,
  "ACP @@dispatch is non-interactive (cancels on permission/write-gate/elicitation)": `case "permission_requested": sink.eventBus.publish(buildStatusUpdate({ state: "failed" })); break;`,
  "runtime switch rejects active work": `setRuntime: async (id) => { await session.switchRuntime({ runtime, defaultModel }); }`,
  "AG-UI run coordinator module exists": `// no exports`,
  "AG-UI disconnect cancels controller": `// onAbort does nothing`,
  "AG-UI endpoint honors RunAgentInput.runId": `const runId = crypto.randomUUID();`,
  "A2UI back-channel reaches the WS bridge": `console.log("[web-ui] a2ui surface event:", { surfaceId });`,
  "WS bridge accepts surface_event frame": `case "cancel": await controller.cancel(); break;`,
  "audit module forbids sensitive payload keys": `export type AuditEvent = { kind: "x"; prompt: string };`,
  "AuditEvent does not claim coverage it lacks": `export type AuditEvent = { kind: "registry-sync-served"; correlationId: string; at: string; recordCount: number };`,
};

describe("release-readiness source guards", () => {
  test("all checks pass on the current source tree", async () => {
    const issues = await auditReleaseReadinessDefaults(repoRoot);
    expect(issues).toEqual([]);
  });

  test("each check rejects a deliberately broken contents string", () => {
    expect(RELEASE_READINESS_CHECKS.length).toBeGreaterThan(0);
    for (const check of RELEASE_READINESS_CHECKS) {
      const broken = MUTATIONS[check.name];
      expect(broken).toBeDefined();
      const result = check.validate(broken as string);
      expect(result, `expected mutation for "${check.name}" to fail validation`).not.toBeNull();
    }
  });

  test("each check passes on its own actual source file", async () => {
    for (const check of RELEASE_READINESS_CHECKS) {
      const contents = await readFile(path.join(repoRoot, check.filePath), "utf8");
      const result = check.validate(contents);
      expect(result, `check "${check.name}" failed unexpectedly: ${result ?? ""}`).toBeNull();
    }
  });
});
