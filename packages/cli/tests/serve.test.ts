import { describe, expect, test } from "bun:test";
import {
  parseServeCommandArgs,
  resolveCardNameOverride,
  shouldEnableRegistrySync,
} from "../src/serve.ts";

/**
 * Registry sync is a network surface — its default must stay explicit and
 * its enable predicate must be unambiguous. We test the boundary cases
 * (off by default, on via flag, on via the literal env value) plus the
 * non-boolean strings that should NOT enable it. Operators expect
 * `--registry-sync` and `AGENTS_JS_REGISTRY_SYNC=true` to behave; they
 * do not expect `=1` or `=yes` to silently turn on a peer-discovery
 * endpoint.
 */
describe("shouldEnableRegistrySync", () => {
  test("default — off when flag absent and env unset", () => {
    expect(shouldEnableRegistrySync({}, {})).toBe(false);
  });

  test("--registry-sync flag enables sync", () => {
    expect(shouldEnableRegistrySync({ registrySync: true }, {})).toBe(true);
  });

  test("AGENTS_JS_REGISTRY_SYNC=true enables sync", () => {
    expect(shouldEnableRegistrySync({}, { AGENTS_JS_REGISTRY_SYNC: "true" })).toBe(true);
  });

  test("flag wins over env when both are set", () => {
    expect(
      shouldEnableRegistrySync({ registrySync: true }, { AGENTS_JS_REGISTRY_SYNC: "false" }),
    ).toBe(true);
  });

  test("env values other than the literal string 'true' do NOT enable sync", () => {
    for (const value of ["1", "yes", "TRUE", "True", "on", " true ", ""]) {
      expect(shouldEnableRegistrySync({}, { AGENTS_JS_REGISTRY_SYNC: value })).toBe(false);
    }
  });

  test("registrySync=false with no env stays off", () => {
    expect(shouldEnableRegistrySync({ registrySync: false }, {})).toBe(false);
  });
});

/**
 * `--card-name` / `AGENTS_JS_CARD_NAME` overrides exist to disambiguate
 * the published gateway agent card when two gateway processes co-host
 * on the same machine. The override pipeline must (a) accept the flag,
 * (b) honor the env fallback, (c) prefer the explicit flag, and (d)
 * reject empty/whitespace-only values so an operator does not get a
 * silent registration under a blank name (AJS-86).
 */
describe("resolveCardNameOverride", () => {
  test("returns undefined when neither flag nor env is set", () => {
    expect(resolveCardNameOverride({}, {})).toBeUndefined();
  });

  test("--card-name flag wins when present", () => {
    expect(resolveCardNameOverride({ cardName: "hostname-null-codex-app" }, {})).toBe(
      "hostname-null-codex-app",
    );
  });

  test("AGENTS_JS_CARD_NAME provides the env fallback", () => {
    expect(resolveCardNameOverride({}, { AGENTS_JS_CARD_NAME: "envname-acp-gateway" })).toBe(
      "envname-acp-gateway",
    );
  });

  test("flag wins over env when both are set", () => {
    expect(
      resolveCardNameOverride(
        { cardName: "flagwins-acp-gateway" },
        { AGENTS_JS_CARD_NAME: "envname-acp-gateway" },
      ),
    ).toBe("flagwins-acp-gateway");
  });

  test("empty / whitespace-only values are rejected (treated as unset)", () => {
    expect(resolveCardNameOverride({ cardName: "" }, {})).toBeUndefined();
    expect(resolveCardNameOverride({ cardName: "   " }, {})).toBeUndefined();
    expect(resolveCardNameOverride({}, { AGENTS_JS_CARD_NAME: "" })).toBeUndefined();
    expect(resolveCardNameOverride({}, { AGENTS_JS_CARD_NAME: "  " })).toBeUndefined();
  });

  test("trims surrounding whitespace from the resolved value", () => {
    expect(resolveCardNameOverride({ cardName: "  padded  " }, {})).toBe("padded");
  });
});

/**
 * `--card-name` must round-trip through the argv parser onto
 * `ServeCommandArgs.cardName`. Asserted directly because the override
 * pipeline (resolveCardNameOverride → runtime.agentCard.name → registry
 * write) cannot fix a flag that the parser silently drops.
 */
describe("parseServeCommandArgs — --card-name", () => {
  test("parses --card-name into ServeCommandArgs.cardName", () => {
    const args = parseServeCommandArgs([
      "--harness",
      "opencode",
      "--card-name",
      "hostname-null-ajs-pi-0",
    ]);
    expect(args.cardName).toBe("hostname-null-ajs-pi-0");
  });

  test("absent --card-name leaves cardName undefined", () => {
    const args = parseServeCommandArgs(["--harness", "opencode"]);
    expect(args.cardName).toBeUndefined();
  });
});
