import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  AppServerCodexRunner,
  assertNoCodexSandboxBypass,
  buildEnforcedCodexExecArgs,
  ExecResumeCodexRunner,
  type JsonRpcClient,
  proveAppServerRunner,
  selectCodexRunner,
} from "../src/codex-runner.ts";

describe("AppServerCodexRunner", () => {
  test("uses thread/resume then turn/start", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client: JsonRpcClient = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === "thread/resume") return { thread_id: "t1" };
        return { reply: "ok" };
      },
    };

    const out = await new AppServerCodexRunner(client).run("prompt");

    expect(out.reply).toBe("ok");
    expect(calls).toEqual([
      { method: "thread/resume", params: { last: true } },
      { method: "turn/start", params: { thread_id: "t1", prompt: "prompt" } },
    ]);
  });

  test("proof returns false on JSON-RPC failure", async () => {
    const client: JsonRpcClient = {
      async request() {
        throw new Error("no app server");
      },
    };

    expect(await proveAppServerRunner(client)).toBe(false);
  });

  test("proof locks thread/resume plus dry-run turn/start params", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client: JsonRpcClient = {
      async request(method, params) {
        calls.push({ method, params });
        return { ok: true };
      },
    };

    expect(await proveAppServerRunner(client)).toBe(true);
    expect(calls).toEqual([
      { method: "thread/resume", params: { last: true } },
      {
        method: "turn/start",
        params: { dry_run: true, prompt: "agents-js app-server proof" },
      },
    ]);
  });

  test("selector uses app-server when proof succeeds", async () => {
    const calls: string[] = [];
    const runner = await selectCodexRunner({
      appServerClient: {
        async request(method) {
          calls.push(method);
          if (method === "thread/resume") return { thread_id: "t1" };
          return { reply: "ok" };
        },
      },
    });

    expect(calls).toEqual(["thread/resume", "turn/start"]);
    expect(await runner.run("prompt")).toEqual({ reply: "ok" });
  });

  test("selector falls back to exec-resume when proof fails", async () => {
    const fallback = {
      async run() {
        return { reply: "fallback" };
      },
    };
    const runner = await selectCodexRunner({
      appServerClient: {
        async request() {
          throw new Error("no app server");
        },
      },
      execRunner: fallback,
    });

    expect(runner).toBe(fallback);
  });
});

describe("ExecResumeCodexRunner", () => {
  test("writes prompt to stdin and extracts JSONL reply", async () => {
    let stdin = "";
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin.on("data", (chunk) => {
      stdin += String(chunk);
    });
    const spawnImpl = (() => child) as never;
    const promise = new ExecResumeCodexRunner({ spawnImpl }).run("hello");

    child.stdout.write(`${JSON.stringify({ reply: "done" })}\n`);
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({ reply: "done" });
    expect(stdin).toBe("hello");
  });

  test("can run resume from a workspace cwd with git-check bypass", async () => {
    let captured:
      | {
          command: string;
          args: string[];
          cwd?: string;
        }
      | undefined;
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const spawnImpl = ((command: string, args: string[], options: { cwd?: string }) => {
      captured = { command, args, cwd: options.cwd };
      return child;
    }) as never;
    const promise = new ExecResumeCodexRunner({
      cwd: "/agent-workspace",
      skipGitRepoCheck: true,
      spawnImpl,
    }).run("hello");

    child.stdout.write(`${JSON.stringify({ reply: "done" })}\n`);
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({ reply: "done" });
    expect(captured).toEqual({
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        "read-only",
        "resume",
        "--last",
        "--skip-git-repo-check",
        "--json",
        "-",
      ],
      cwd: "/agent-workspace",
    });
  });
});

describe("ExecResumeCodexRunner #92 sandbox gate", () => {
  test("default argv enforces --sandbox read-only before resume", () => {
    const args = buildEnforcedCodexExecArgs();
    expect(args).toEqual(["exec", "--sandbox", "read-only", "resume", "--last", "--json", "-"]);
    // --sandbox must precede resume (codex rejects it after resume)
    expect(args.indexOf("--sandbox")).toBeLessThan(args.indexOf("resume"));
  });

  test("workspace-write is an explicit source-owned mode", () => {
    const args = buildEnforcedCodexExecArgs({
      sandboxMode: "workspace-write",
      skipGitRepoCheck: true,
    });
    expect(args).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "resume",
      "--last",
      "--skip-git-repo-check",
      "--json",
      "-",
    ]);
  });

  test("assertNoCodexSandboxBypass rejects the dangerous bypass flag", () => {
    expect(() =>
      assertNoCodexSandboxBypass(["exec", "--dangerously-bypass-approvals-and-sandbox", "resume"]),
    ).toThrow(/refusing --dangerously-bypass-approvals-and-sandbox/);
  });

  test("assertNoCodexSandboxBypass rejects danger-full-access (spaced and joined)", () => {
    expect(() => assertNoCodexSandboxBypass(["--sandbox", "danger-full-access"])).toThrow(
      /danger-full-access/,
    );
    expect(() => assertNoCodexSandboxBypass(["--sandbox=danger-full-access"])).toThrow(
      /danger-full-access/,
    );
  });

  test("explicit args without --sandbox are refused (gate cannot be dissolved)", () => {
    expect(
      () => new ExecResumeCodexRunner({ args: ["exec", "resume", "--last", "--json", "-"] }),
    ).toThrow(/must pin --sandbox/);
  });

  test("explicit args carrying the bypass are refused", () => {
    expect(
      () =>
        new ExecResumeCodexRunner({
          args: [
            "exec",
            "--sandbox",
            "read-only",
            "--dangerously-bypass-approvals-and-sandbox",
            "resume",
          ],
        }),
    ).toThrow(/refusing --dangerously-bypass-approvals-and-sandbox/);
  });

  test("explicit args with a non-dangerous sandbox are accepted", () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let captured: string[] | undefined;
    const spawnImpl = ((_c: string, args: string[]) => {
      captured = args;
      return child;
    }) as never;
    void new ExecResumeCodexRunner({
      args: ["exec", "--sandbox", "workspace-write", "resume", "--last", "--json", "-"],
      spawnImpl,
    }).run("hi");
    child.emit("close", 0);
    expect(captured).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "resume",
      "--last",
      "--json",
      "-",
    ]);
  });
});
