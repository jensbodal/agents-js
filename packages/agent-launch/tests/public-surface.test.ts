/**
 * Public-surface contract for `@agents-js/agent-launch` — the tmux **window-ops**
 * seam.
 *
 * The dual-window primitive (`createTmuxWindowOps` + its option/return types)
 * MUST be importable from the package's public entry (`.`), so the consuming
 * parts of the pi dual-window work — the CLI plan/launch path (parts 2/3) and
 * any external orchestrator — can compose a layout (`:0`=TUI / `:1`=runtime)
 * without reaching a deep `src/tmux-windows.ts` import. The module's internal
 * correctness is pinned by `tests/unit/tmux-windows.test.ts`; this test pins the
 * *seam*: that it crosses the index boundary and is consumable as a unit.
 *
 * Mirrors `claude-channel-adapter`'s `tests/public-surface.test.ts`: a flow
 * wired entirely from the public index (with an injected spawner — no real tmux
 * binary) proves the surface is composable, not merely present.
 */
import { describe, expect, test } from "bun:test";
import {
  createTmuxWindowOps,
  type TmuxAttach,
  type TmuxWindowOps,
  type TmuxWindowOpsOptions,
} from "../src/index.ts";

describe("public surface — tmux window-ops seam", () => {
  test("createTmuxWindowOps is exported from the public entry", () => {
    expect(typeof createTmuxWindowOps).toBe("function");
  });

  test("the dual-window layout composes from the public surface — argv flows to an injected spawner", () => {
    // A recorder injected through the public option types, exactly as parts 2/3
    // (the CLI launch path) wire it — proving the seam is consumable, not just
    // exported. Attach has its own recorder: it must NOT route through the
    // capturing spawner (it hands the terminal to tmux via inherited stdio).
    const calls: (readonly string[])[] = [];
    const attachCalls: (readonly string[])[] = [];
    const attach: TmuxAttach = (args) => attachCalls.push(args);
    const options: TmuxWindowOpsOptions = {
      // `base-index 1` operator: first window reports as :1, must normalize to :0.
      spawner: (args) => {
        calls.push(args);
        const isListWindows = args[0] === "list-windows";
        return { status: 0, stdout: isListWindows ? "1\n" : "", stderr: "" };
      },
      attach,
    };

    const ops: TmuxWindowOps = createTmuxWindowOps(options);
    ops.normalizeFirstWindowToZero("agent-x");
    ops.newWindow("agent-x", 1, "runtime", "/work");
    ops.selectWindow("agent-x", 0);
    ops.attachOrSwitch("agent-x");

    // list-windows → move-window (:1 → :0) → new-window (:1) → select-window (:0)
    expect(calls.map((c) => c[0])).toEqual([
      "list-windows",
      "move-window",
      "new-window",
      "select-window",
    ]);
    // attach-session ran off the spawner, via the dedicated interactive seam.
    expect(attachCalls).toEqual([["attach-session", "-t", "agent-x"]]);
  });
});
