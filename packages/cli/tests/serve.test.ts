import { describe, expect, test } from "bun:test";
import { shouldEnableRegistrySync } from "../src/serve.ts";

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
