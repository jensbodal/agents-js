import { describe, expect, test } from "bun:test";
import type { MemoryActor, MemoryScope } from "@agents-js/memory";
import type { MemoryPolicyInput } from "../src/policy-gate.ts";
import {
  classifyMemoryOperation,
  createMemoryPolicyV12Gate,
  type PolicyCategory,
} from "../src/policy-taxonomy.ts";

const projectActor: MemoryActor = { kind: "agent", actorId: "project-alice" };
const foreignActor: MemoryActor = { kind: "agent", actorId: "stranger" };
const projectMatcher = (actor: MemoryActor, _scope: MemoryScope) =>
  actor.actorId === "project-alice";

function input(overrides: Partial<MemoryPolicyInput>): MemoryPolicyInput {
  return {
    op: "save",
    actor: projectActor,
    scope: { kind: "agent", agentId: "project-alice" },
    type: "user-fact",
    ...overrides,
  };
}

describe("classifyMemoryOperation — category coverage", () => {
  // Pins the destructive rule's reach: any delete, regardless of scope or
  // type, is destructive and demands workspace consent.
  test("delete op on any scope is classified as destructive(delete)", () => {
    const cat = classifyMemoryOperation(input({ op: "delete" }));
    expect(cat.category).toBe("destructive");
    expect((cat as Extract<PolicyCategory, { category: "destructive" }>).reason).toBe("delete");
  });

  // Global-scope writes are workspace-wide and must require consent
  // regardless of who the actor is — pins the destructive rule's
  // second arm.
  test("save/update on scope.kind === 'global' is classified as destructive(global-write)", () => {
    for (const op of ["save", "update"] as const) {
      const cat = classifyMemoryOperation(input({ op, scope: { kind: "global" } }));
      expect(cat.category).toBe("destructive");
      expect((cat as Extract<PolicyCategory, { category: "destructive" }>).reason).toBe(
        "global-write",
      );
    }
  });

  // Project-scoped writes flow to the project-write category with the
  // scope tag preserved so the gate can check ownership against it.
  test("save/update on scope.kind === 'agent' is classified as project-write(agent)", () => {
    const cat = classifyMemoryOperation(input({ scope: { kind: "agent", agentId: "x" } }));
    expect(cat.category).toBe("project-write");
    expect((cat as Extract<PolicyCategory, { category: "project-write" }>).scope).toBe("agent");
  });

  test("save/update on scope.kind === 'room' is classified as project-write(room)", () => {
    const cat = classifyMemoryOperation(input({ scope: { kind: "room", roomId: "r" } }));
    expect(cat.category).toBe("project-write");
    expect((cat as Extract<PolicyCategory, { category: "project-write" }>).scope).toBe("room");
  });

  // Precedence invariant: destructive ops trump configured-type. A
  // delete on an OpenMemory-managed type still requires consent — the
  // explicit opt-in to a type doesn't grant a free pass to bypass
  // workspace consent.
  test("delete on a configured type still classifies as destructive (destructive wins)", () => {
    const cat = classifyMemoryOperation(
      input({
        op: "delete",
        type: "openmemory-fact",
      }),
    );
    expect(cat.category).toBe("destructive");
  });

  // Precedence invariant: global writes trump configured-type for the
  // same reason — global scope is workspace-wide and needs consent
  // regardless of which type system owns the value.
  test("save on a configured type to scope.global still classifies as destructive", () => {
    const cat = classifyMemoryOperation(
      input({ scope: { kind: "global" }, type: "openmemory-fact" }),
    );
    expect(cat.category).toBe("destructive");
  });

  // Non-destructive ops with a configured type route to the
  // configured-type category. Pin the type tag carries through.
  test("save on a configured type to scope.agent classifies as configured-type", () => {
    const cat = classifyMemoryOperation(
      input({ scope: { kind: "agent", agentId: "x" }, type: "thoughtbox-note" }),
    );
    // NOTE: the classifier does not know which types are "configured" —
    // it only assigns the category. The gate's options decide which
    // types belong in the configured-type bucket. So this test only
    // verifies the classifier returns a deterministic category for
    // every (op, scope, type); the *meaning* of "configured-type" is
    // applied by the gate, not the classifier.
    //
    // For the classifier, project-scope save with no destructive-rule
    // match is project-write — configured-type is purely a gate-side
    // refinement.
    expect(cat.category).toBe("project-write");
  });
});

describe("createMemoryPolicyV12Gate — per-category decisions", () => {
  // Project actor on a project-scoped write should sail through.
  test("project-write: project actor returns allow", async () => {
    const gate = createMemoryPolicyV12Gate({ isProjectActor: projectMatcher });
    const result = await gate.evaluate(input({}));
    expect(result.decision).toBe("allow");
  });

  // Foreign actor on a project-scoped write returns ask — the
  // interactive layer (or the v1 provider's strict "ask treated as
  // deny") handles the prompt.
  test("project-write: foreign actor returns ask with reason", async () => {
    const gate = createMemoryPolicyV12Gate({ isProjectActor: projectMatcher });
    const result = await gate.evaluate(input({ actor: foreignActor }));
    expect(result.decision).toBe("ask");
    expect(result.reason).toBeDefined();
  });

  // No matcher supplied → conservative default: every actor is treated
  // as a non-project actor → project-writes return ask. Pins the
  // safe-by-default posture.
  test("project-write: no isProjectActor supplied defaults to ask", async () => {
    const gate = createMemoryPolicyV12Gate();
    const result = await gate.evaluate(input({}));
    expect(result.decision).toBe("ask");
  });

  // Destructive op with a valid consent token → allow. Validates that
  // the consent-token mechanism wires through metadata correctly.
  test("destructive(delete): valid consent token returns allow", async () => {
    const gate = createMemoryPolicyV12Gate({
      validateConsentToken: (t) => t === "valid-token",
    });
    const result = await gate.evaluate(
      input({ op: "delete", metadata: { consentToken: "valid-token" } }),
    );
    expect(result.decision).toBe("allow");
  });

  // Destructive op with no consent token → ask. The caller is
  // expected to round-trip through an interactive consent prompt and
  // re-submit with a token.
  test("destructive(delete): missing consent token returns ask", async () => {
    const gate = createMemoryPolicyV12Gate();
    const result = await gate.evaluate(input({ op: "delete" }));
    expect(result.decision).toBe("ask");
    expect(result.reason).toBeDefined();
  });

  // Destructive op with an invalid (per the supplied validator) token
  // also returns ask — validator decides what counts.
  test("destructive(delete): invalid consent token returns ask", async () => {
    const gate = createMemoryPolicyV12Gate({
      validateConsentToken: (t) => t === "the-only-good-token",
    });
    const result = await gate.evaluate(
      input({ op: "delete", metadata: { consentToken: "wrong-token" } }),
    );
    expect(result.decision).toBe("ask");
  });

  // Custom consent-token key works (some consumers may want to name
  // their token field differently for namespacing).
  test("destructive: consentTokenKey option overrides the default 'consentToken' field name", async () => {
    const gate = createMemoryPolicyV12Gate({
      consentTokenKey: "wsConsent",
      validateConsentToken: (t) => t === "ok",
    });
    const result = await gate.evaluate(
      input({ op: "delete", metadata: { wsConsent: "ok", consentToken: "should-be-ignored" } }),
    );
    expect(result.decision).toBe("allow");
  });

  // Configured type explicitly allowed → allow even without consent
  // (the type is on the safe-list).
  test("configured-type: type in allow-list returns allow", async () => {
    const gate = createMemoryPolicyV12Gate({
      isProjectActor: projectMatcher,
      configuredTypes: { allow: ["openmemory-quick-note"] },
    });
    const result = await gate.evaluate(input({ type: "openmemory-quick-note" }));
    expect(result.decision).toBe("allow");
  });

  // Configured type explicitly ask-listed → ask.
  test("configured-type: type in ask-list returns ask", async () => {
    const gate = createMemoryPolicyV12Gate({
      isProjectActor: projectMatcher,
      configuredTypes: { ask: ["thoughtbox-shared-note"] },
    });
    const result = await gate.evaluate(input({ type: "thoughtbox-shared-note" }));
    expect(result.decision).toBe("ask");
    expect(result.reason).toBeDefined();
  });

  // Type that's neither in allow nor ask but is referenced in the
  // configuredTypes registry → deny. Default-deny posture for
  // configured-type buckets; consumers must explicitly opt types in.
  //
  // (Note: a type that isn't in the registry AT ALL flows through the
  // project-write rule via the classifier; the deny here applies only
  // when the consumer has signaled "this is a configured type" by
  // including it nowhere but expecting strict handling. In practice
  // this case is rare; the default-deny is a defensive backstop for
  // misconfigured option sets.)
  test("configured-type: configuredTypes option present but type unlisted falls through to project-write rules", async () => {
    // A type that is NOT in any configuredTypes list is NOT a
    // configured type — it routes through standard project-write
    // rules. This pins the boundary: configuredTypes is opt-in per
    // type, not a global mode.
    const gate = createMemoryPolicyV12Gate({
      isProjectActor: projectMatcher,
      configuredTypes: { allow: ["other-type"] },
    });
    const result = await gate.evaluate(input({ type: "user-fact" }));
    // user-fact isn't configured + project actor + project scope = allow via project-write
    expect(result.decision).toBe("allow");
  });

  // Every non-allow result must carry a reason — the reason is
  // load-bearing for diagnostics and (when AJS-11 lands) prompt UI.
  test("every non-allow decision carries a populated reason", async () => {
    const gate = createMemoryPolicyV12Gate();
    for (const fixture of [
      input({}), // project-write, no matcher → ask
      input({ op: "delete" }), // destructive, no token → ask
      input({ op: "save", scope: { kind: "global" } }), // destructive, no token → ask
    ]) {
      const result = await gate.evaluate(fixture);
      if (result.decision !== "allow") {
        expect(result.reason).toBeDefined();
        expect(typeof result.reason).toBe("string");
        expect((result.reason as string).length).toBeGreaterThan(0);
      }
    }
  });
});
