/**
 * Learning tests for the tmux window-ops seam (composable multi-window layer for
 * the pi cockpit launch). Mirrors tmux.test.ts: a mock spawner records argv
 * so no real tmux binary is needed. The interactive attach has its own recorder
 * (it must not go through the capturing spawner).
 *
 * LT-1: two-window creation emits the correct tmux argv, in order.
 * LT-2: the TUI is forced to window :0 regardless of the operator's base-index.
 */
import { describe, expect, test } from "bun:test";
import type { TmuxSpawnResult } from "../../src/tmux.ts";
import { createTmuxWindowOps } from "../../src/tmux-windows.ts";

interface CallRecord {
  readonly args: readonly string[];
}

function mockSpawner(responses: readonly TmuxSpawnResult[]): {
  spawner: (args: readonly string[]) => TmuxSpawnResult;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let i = 0;
  const spawner = (args: readonly string[]): TmuxSpawnResult => {
    calls.push({ args });
    const r = responses[i++];
    if (!r) {
      return { status: 0, stdout: "", stderr: "" };
    }
    return r;
  };
  return { spawner, calls };
}

function recordingAttach(): { attach: (args: readonly string[]) => void; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  return { attach: (args) => calls.push({ args }), calls };
}

const ok = (stdout = ""): TmuxSpawnResult => ({ status: 0, stdout, stderr: "" });

// LT-1 ----------------------------------------------------------------------
describe("tmux-windows — LT-1: two-window creation emits correct argv", () => {
  test("newWindow creates a detached window at the given index", () => {
    const { spawner, calls } = mockSpawner([ok()]);
    const ops = createTmuxWindowOps({ spawner });
    ops.newWindow("agent-x", 1, "runtime", "/work");
    expect(calls[0]?.args).toEqual([
      "new-window",
      "-d",
      "-t",
      "agent-x:1",
      "-n",
      "runtime",
      "-c",
      "/work",
    ]);
  });

  test("selectWindow focuses the indexed window", () => {
    const { spawner, calls } = mockSpawner([ok()]);
    const ops = createTmuxWindowOps({ spawner });
    ops.selectWindow("agent-x", 0);
    expect(calls[0]?.args).toEqual(["select-window", "-t", "agent-x:0"]);
  });

  test("sendKeysToWindow targets a specific window's pane with payload + Enter", () => {
    const { spawner, calls } = mockSpawner([ok()]);
    const ops = createTmuxWindowOps({ spawner });
    ops.sendKeysToWindow("agent-x", 1, "pi -e @agents-js/pi-extension");
    expect(calls[0]?.args).toEqual([
      "send-keys",
      "-t",
      "agent-x:1",
      "pi -e @agents-js/pi-extension",
      "Enter",
    ]);
  });

  test("full :0 TUI + :1 runtime sequence emits ordered argv", () => {
    // base-index 0 already (firstWindowIndex returns "0" → no move).
    const { spawner, calls } = mockSpawner([
      ok("0\n"), // firstWindowIndex (list-windows)
      ok(), // new-window :1
      ok(), // select-window :0
    ]);
    const ops = createTmuxWindowOps({ spawner });
    ops.normalizeFirstWindowToZero("agent-x");
    ops.newWindow("agent-x", 1, "runtime", "/work");
    ops.selectWindow("agent-x", 0);
    expect(calls.map((c) => c.args[0])).toEqual(["list-windows", "new-window", "select-window"]);
    expect(calls[1]?.args).toContain("agent-x:1");
    expect(calls[2]?.args).toContain("agent-x:0");
  });
});

// LT-2 ----------------------------------------------------------------------
describe("tmux-windows — LT-2: TUI forced to :0 regardless of base-index", () => {
  test("base-index 1: first window is moved to :0", () => {
    const { spawner, calls } = mockSpawner([
      ok("1\n"), // firstWindowIndex → 1 (base-index 1)
      ok(), // move-window
    ]);
    const ops = createTmuxWindowOps({ spawner });
    ops.normalizeFirstWindowToZero("agent-x");
    expect(calls[0]?.args).toEqual(["list-windows", "-t", "agent-x", "-F", "#{window_index}"]);
    expect(calls[1]?.args).toEqual(["move-window", "-s", "agent-x:1", "-t", "agent-x:0"]);
  });

  test("base-index 0: no move issued (already at :0)", () => {
    const { spawner, calls } = mockSpawner([ok("0\n")]);
    const ops = createTmuxWindowOps({ spawner });
    ops.normalizeFirstWindowToZero("agent-x");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("list-windows");
  });

  test("same plan under base-index 0 and 1 yields identical final window targets", () => {
    const run = (firstIdx: string): { runtime?: string; focus?: string } => {
      const { spawner, calls } = mockSpawner([ok(`${firstIdx}\n`)]);
      const ops = createTmuxWindowOps({ spawner });
      ops.normalizeFirstWindowToZero("agent-x");
      ops.newWindow("agent-x", 1, "runtime", "/work");
      ops.selectWindow("agent-x", 0);
      const target = (cmd: string): string | undefined =>
        calls.find((c) => c.args[0] === cmd)?.args.find((a) => a.startsWith("agent-x:"));
      return { runtime: target("new-window"), focus: target("select-window") };
    };
    // Under both base-index values the runtime lands on :1 and the focus on :0.
    expect(run("1")).toEqual({ runtime: "agent-x:1", focus: "agent-x:0" });
    expect(run("0")).toEqual({ runtime: "agent-x:1", focus: "agent-x:0" });
  });

  test("unparseable list-windows output throws a descriptive error", () => {
    const { spawner } = mockSpawner([ok("not-a-number\n")]);
    const ops = createTmuxWindowOps({ spawner });
    expect(() => ops.normalizeFirstWindowToZero("agent-x")).toThrow(
      /could not parse first window index/,
    );
  });
});

// attach --------------------------------------------------------------------
describe("tmux-windows — attachOrSwitch", () => {
  test("attaches when outside tmux", () => {
    const { attach, calls } = recordingAttach();
    const ops = createTmuxWindowOps({
      spawner: mockSpawner([]).spawner,
      attach,
      insideTmux: false,
    });
    ops.attachOrSwitch("agent-x");
    expect(calls[0]?.args).toEqual(["attach-session", "-t", "agent-x"]);
  });

  test("switches client when already inside tmux", () => {
    const { attach, calls } = recordingAttach();
    const ops = createTmuxWindowOps({ spawner: mockSpawner([]).spawner, attach, insideTmux: true });
    ops.attachOrSwitch("agent-x");
    expect(calls[0]?.args).toEqual(["switch-client", "-t", "agent-x"]);
  });
});
