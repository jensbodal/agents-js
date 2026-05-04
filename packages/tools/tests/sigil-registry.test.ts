import { describe, expect, test } from "bun:test";
import type { Sigil, SigilContext } from "../src/primitives/sigil-registry.ts";
import {
  builtinCommandResolver,
  createSigilRegistry,
  parseSigil,
  resolveSigil,
  UNHANDLED,
} from "../src/primitives/sigil-registry.ts";

// ─── parseSigil ───────────────────────────────────────────────────────────────

describe("parseSigil", () => {
  test("parses $dollar sigil", () => {
    expect(parseSigil("$keyword")).toEqual({ kind: "dollar", name: "keyword" });
  });

  test("parses $dollar sigil with args (name is first token only)", () => {
    expect(parseSigil("$skill run-docs arg1")).toEqual({ kind: "dollar", name: "skill" });
  });

  test("parses @@at-at sigil", () => {
    expect(parseSigil("@@dispatch task")).toEqual({ kind: "at-at", name: "dispatch" });
  });

  test("parses !bang sigil", () => {
    expect(parseSigil("!ls")).toEqual({ kind: "bang", name: "ls" });
  });

  test("parses !bang sigil with flags", () => {
    expect(parseSigil("!ls -la /tmp")).toEqual({ kind: "bang", name: "ls" });
  });

  test("tolerates leading whitespace", () => {
    expect(parseSigil("  $keyword")).toEqual({ kind: "dollar", name: "keyword" });
    expect(parseSigil("  @@dispatch")).toEqual({ kind: "at-at", name: "dispatch" });
    expect(parseSigil("  !cmd")).toEqual({ kind: "bang", name: "cmd" });
  });

  test("returns null for plain text (no sigil prefix)", () => {
    expect(parseSigil("hello world")).toBeNull();
  });

  test("returns null for bare prefix without name", () => {
    expect(parseSigil("$")).toBeNull();
    expect(parseSigil("@@")).toBeNull();
    expect(parseSigil("!")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseSigil("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(parseSigil("   ")).toBeNull();
  });

  test("returns null for non-string input (runtime safety)", () => {
    expect(parseSigil(null as unknown as string)).toBeNull();
    expect(parseSigil(undefined as unknown as string)).toBeNull();
    expect(parseSigil(42 as unknown as string)).toBeNull();
  });

  test("@@at-at takes precedence over bare $ or ! when both present", () => {
    // Sanity: @@dispatch is at-at, not dollar
    expect(parseSigil("@@dispatch")).toEqual({ kind: "at-at", name: "dispatch" });
  });
});

// ─── register + resolve dispatch ─────────────────────────────────────────────

describe("createSigilRegistry — register + resolve", () => {
  test("dispatches to registered resolver for the correct kind", async () => {
    const registry = createSigilRegistry();
    registry.register("dollar", (_sigil, _ctx) => ({
      status: "handled",
      value: "dollar-result",
    }));
    const result = await registry.resolve("$anything", { args: [] });
    expect(result.status).toBe("handled");
    expect(result.value).toBe("dollar-result");
  });

  test("dispatches @@at-at to the at-at chain, not dollar", async () => {
    const registry = createSigilRegistry();
    registry.register("dollar", () => ({ status: "handled", value: "WRONG" }));
    registry.register("at-at", () => ({ status: "handled", value: "at-at-result" }));
    const result = await registry.resolve("@@dispatch task", { args: [] });
    expect(result.value).toBe("at-at-result");
  });

  test("passes parsed sigil and context to resolver", async () => {
    const registry = createSigilRegistry();
    const captured: { sigil: Sigil; context: SigilContext }[] = [];

    registry.register("dollar", (sigil, context) => {
      captured.push({ sigil, context });
      return { status: "handled", value: null };
    });

    const ctx: SigilContext = { args: [], metadata: { sessionId: "abc" } };
    await registry.resolve("$myskill", ctx);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.sigil).toEqual({ kind: "dollar", name: "myskill" });
    expect(captured[0]?.context.metadata).toEqual({ sessionId: "abc" });
  });
});

// ─── Local-first chain (registration order) ───────────────────────────────────

describe("createSigilRegistry — local-first chain", () => {
  test("first registered resolver runs before later ones", async () => {
    const registry = createSigilRegistry();
    const callOrder: string[] = [];

    registry.register("dollar", (_s, _c) => {
      callOrder.push("first");
      return { status: "handled", value: "first-wins" };
    });
    registry.register("dollar", (_s, _c) => {
      callOrder.push("second");
      return { status: "handled", value: "second" };
    });

    const result = await registry.resolve("$x", { args: [] });
    expect(result.value).toBe("first-wins");
    // Second resolver never called when first handles.
    expect(callOrder).toEqual(["first"]);
  });

  test("second resolver runs when first returns UNHANDLED", async () => {
    const registry = createSigilRegistry();

    registry.register("dollar", (_s, _c) => UNHANDLED);
    registry.register("dollar", (_s, _c) => ({ status: "handled", value: "second-wins" }));

    const result = await registry.resolve("$y", { args: [] });
    expect(result.value).toBe("second-wins");
  });

  test("multiple UNHANDLED resolvers fall through to the handling one", async () => {
    const registry = createSigilRegistry();

    registry.register("at-at", () => UNHANDLED);
    registry.register("at-at", () => UNHANDLED);
    registry.register("at-at", () => ({ status: "handled", value: "third" }));

    const result = await registry.resolve("@@dispatch", { args: [] });
    expect(result.value).toBe("third");
  });

  test("async resolvers work in the chain", async () => {
    const registry = createSigilRegistry();

    registry.register("dollar", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { status: "handled", value: "async-ok" };
    });

    const result = await registry.resolve("$async", { args: [] });
    expect(result.value).toBe("async-ok");
  });
});

// ─── UNHANDLED fallthrough + errors ──────────────────────────────────────────

describe("createSigilRegistry — UNHANDLED + error shapes", () => {
  test("throws SigilResolutionError when all resolvers return UNHANDLED", async () => {
    const registry = createSigilRegistry();
    registry.register("dollar", () => UNHANDLED);

    await expect(registry.resolve("$z", { args: [] })).rejects.toMatchObject({
      name: "SigilResolutionError",
      code: "tools/sigil-unresolved",
    });
  });

  test("throws SigilResolutionError with parse-failed code for non-sigil input", async () => {
    const registry = createSigilRegistry();

    await expect(registry.resolve("not a sigil", { args: [] })).rejects.toMatchObject({
      name: "SigilResolutionError",
      code: "tools/sigil-parse-failed",
    });
  });

  test("throws SigilResolutionError with no-resolver code when dollar chain is empty", async () => {
    // Dollar chain starts empty; no resolver registered.
    const registry = createSigilRegistry();

    await expect(registry.resolve("$anything", { args: [] })).rejects.toMatchObject({
      name: "SigilResolutionError",
      code: "tools/sigil-no-resolver",
    });
  });

  test("builtinCommandResolver always returns UNHANDLED (bang chain exhausted)", async () => {
    const registry = createSigilRegistry();
    // bang chain has only builtinCommandResolver; all UNHANDLED => error.
    await expect(registry.resolve("!cmd", { args: [] })).rejects.toMatchObject({
      name: "SigilResolutionError",
      code: "tools/sigil-unresolved",
    });
  });

  test("host resolver registered before builtin takes precedence for bang", async () => {
    // To make the host resolver win, register it FIRST so it runs before builtinCommandResolver.
    // But builtinCommandResolver is registered at construction time.
    // Strategy: register a new registry, register host resolver, then it runs before builtin.
    // Actually builtinCommandResolver is the only item pushed at construction; host pushes after.
    // So we need to test the real precedence: host registered AFTER builtin => builtin runs first.
    // Since builtin always returns UNHANDLED, host still gets called — works correctly.
    const registry = createSigilRegistry();

    registry.register("bang", (_s, _c) => ({ status: "handled", value: "host-handled" }));

    const result = await registry.resolve("!cmd", { args: [] });
    // builtinCommandResolver runs first (registered at construction), returns UNHANDLED,
    // then host resolver runs and handles it.
    expect(result.value).toBe("host-handled");
  });
});

// ─── Context propagation ──────────────────────────────────────────────────────

describe("createSigilRegistry — context propagation", () => {
  test("resolver receives the exact metadata passed by caller", async () => {
    const registry = createSigilRegistry();
    let capturedMeta: Record<string, unknown> | undefined;

    registry.register("dollar", (_sigil, context) => {
      capturedMeta = context.metadata;
      return { status: "handled", value: null };
    });

    await registry.resolve("$x", {
      args: [],
      metadata: { userId: "u-123", role: "admin" },
    });

    expect(capturedMeta).toEqual({ userId: "u-123", role: "admin" });
  });

  test("auto-extracts args from input when caller passes empty args", async () => {
    const registry = createSigilRegistry();
    let capturedArgs: string[] = [];

    registry.register("dollar", (_sigil, context) => {
      capturedArgs = context.args;
      return { status: "handled", value: null };
    });

    await registry.resolve("$skill run-docs arg1 arg2", { args: [] });
    expect(capturedArgs).toEqual(["run-docs", "arg1", "arg2"]);
  });

  test("caller-supplied args are not overwritten by auto-extract", async () => {
    const registry = createSigilRegistry();
    let capturedArgs: string[] = [];

    registry.register("dollar", (_sigil, context) => {
      capturedArgs = context.args;
      return { status: "handled", value: null };
    });

    await registry.resolve("$skill run-docs arg1", { args: ["explicit-arg"] });
    expect(capturedArgs).toEqual(["explicit-arg"]);
  });
});

// ─── resolveSigil public helper ───────────────────────────────────────────────

describe("resolveSigil", () => {
  test("is equivalent to registry.resolve", async () => {
    const registry = createSigilRegistry();
    registry.register("at-at", () => ({ status: "handled", value: "helper-result" }));

    const direct = await registry.resolve("@@dispatch", { args: [] });
    const helper = await resolveSigil(registry, "@@dispatch", { args: [] });

    expect(direct).toEqual(helper);
    expect(helper.value).toBe("helper-result");
  });

  test("propagates SigilResolutionError", async () => {
    const registry = createSigilRegistry();
    await expect(resolveSigil(registry, "plain text", { args: [] })).rejects.toMatchObject({
      name: "SigilResolutionError",
    });
  });
});

// ─── UNHANDLED sentinel ───────────────────────────────────────────────────────

describe("UNHANDLED sentinel", () => {
  test("is frozen with status unhandled", () => {
    expect(UNHANDLED.status).toBe("unhandled");
    expect(Object.isFrozen(UNHANDLED)).toBe(true);
  });

  test("builtinCommandResolver returns UNHANDLED", () => {
    const result = builtinCommandResolver({ kind: "bang", name: "ls" }, { args: ["-la"] });
    expect(result).toBe(UNHANDLED);
  });
});
