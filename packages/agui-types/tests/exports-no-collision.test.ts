/**
 * Asserts that `@agents-js/agui-types`'s locally-defined exports do not collide
 * with any name re-exported from `@ag-ui/core`. Since `src/index.ts` does
 * `export * from "@ag-ui/core"`, any local export with the same name would
 * silently shadow the upstream symbol — so this test fails fast at PR time
 * if either side adds a colliding name.
 *
 * Note: this checks runtime exports (values) only. Type-only exports are
 * erased before runtime and cannot be enumerated via `Object.keys` on a
 * namespace import. Runtime collisions are the dangerous case (they change
 * what consumer code resolves to); type-only collisions are caught by the
 * TypeScript compiler.
 */
import { describe, expect, test } from "bun:test";
import * as core from "@ag-ui/core";
import * as agui from "../src/index.ts";

/**
 * Names that `@agents-js/agui-types` defines locally (i.e. NOT re-exported
 * from `@ag-ui/core`). Keep this list in sync with `src/index.ts` whenever a
 * new adapter, builder, or helper is added. Adding a new entry here is a
 * deliberate gate: if the name already exists on `@ag-ui/core`, this test
 * will fail and force the author to rename rather than silently shadow.
 */
const AGUI_OWN_RUNTIME_NAMES: readonly string[] = [
  // Adapters (./adapters/*)
  "pickAguiBaseOptionals",
  "toAguiCustom",
  "toAguiReasoningEnd",
  "toAguiReasoningStart",
  "toAguiRunError",
  "toAguiRunFinished",
  "toAguiTextMessageContent",
  "toAguiTextMessageEnd",
  "toAguiTextMessageStart",
  "toAguiToolCallArgs",
  "toAguiToolCallEnd",
  "toAguiToolCallStart",
  // Stateful event-stream builder (./stream.ts)
  "createAguiEventStream",
  // Build-time-derived constant (./index.ts)
  "AGUI_CORE_VERSION",
];

describe("@agents-js/agui-types export surface", () => {
  test("locally-defined names do not collide with @ag-ui/core re-exports", () => {
    const coreNames = new Set(Object.keys(core));
    const collisions = AGUI_OWN_RUNTIME_NAMES.filter((name) => coreNames.has(name));
    expect(collisions).toEqual([]);
  });

  test("declared local names are actually exported from agui-types", () => {
    const aguiNames = new Set(Object.keys(agui));
    const missing = AGUI_OWN_RUNTIME_NAMES.filter((name) => !aguiNames.has(name));
    expect(missing).toEqual([]);
  });

  test("every agui-types runtime export is either from core or in the local list", () => {
    const coreNames = new Set(Object.keys(core));
    const ownNames = new Set(AGUI_OWN_RUNTIME_NAMES);
    const unaccounted = Object.keys(agui).filter(
      (name) => !coreNames.has(name) && !ownNames.has(name),
    );
    // If this fails, a new local export was added to src/index.ts but not
    // registered in AGUI_OWN_RUNTIME_NAMES above. Add it there.
    expect(unaccounted).toEqual([]);
  });
});
