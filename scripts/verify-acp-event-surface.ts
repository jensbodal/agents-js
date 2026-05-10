#!/usr/bin/env bun
/**
 * End-to-end verification: ACP event surface flows through to A2A client.
 *
 * Drives a real `agents-js serve --harness claude` (workspace source, not
 * published) and asserts that the client receives `reasoning.message.chunk`
 * events BEFORE `message.delta` events when claude is thinking, plus
 * `tool_call.start`/`tool_call.end`, `plan.updated`, `commands.updated`,
 * `usage.updated` if those fire.
 *
 * Usage:
 *   bun scripts/verify-acp-event-surface.ts
 *
 * Exits 0 on success, prints a timeline of observed events. Exits 1 with
 * diagnostic output if no thought/tool/plan/etc. events are observed (i.e.
 * the wire surface is broken).
 */

import { spawn } from "node:child_process";
import path from "node:path";
// Use the package's public entry rather than `src/...` so this script
// stays inside the package-boundaries contract enforced by
// `tests/package-boundaries.test.ts`.
import {
  A2AClientController,
  A2AClientProvider,
  createInitialSessionState,
} from "@agents-js/a2a-client";

const PORT = 6970;
// Conversational prompt — no tools. claude-agent-acp emits this kind of
// response as `agent_message_chunk` notifications during streaming.
const PROMPT =
  process.env.VERIFY_PROMPT ??
  "Write a 4-line poem about TypeScript and explain why each line works. No tools needed.";
const TIMEOUT_MS = 120_000;

async function waitForServeReady(port: number, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      if (res.ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`serve did not become ready on port ${port}`);
}

async function main() {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const cliEntry = path.join(repoRoot, "packages/cli/src/cli.ts");

  console.log("[verify] starting agents-js serve --harness claude --port", PORT);
  const serveProc = spawn(
    "bun",
    [cliEntry, "serve", "--harness", "claude", "--port", String(PORT)],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AGENTS_JS_LOG_LEVEL: "info" },
    },
  );

  serveProc.stdout?.on("data", (d) => process.stderr.write(`[serve] ${d}`));
  serveProc.stderr?.on("data", (d) => process.stderr.write(`[serve] ${d}`));

  try {
    await waitForServeReady(PORT, Date.now() + 30_000);
    console.log("[verify] serve ready");

    const provider = new A2AClientProvider();
    let state = createInitialSessionState();
    const events: Array<{ ts: number; type: string; summary: string }> = [];
    const startedAt = Date.now();

    provider.subscribe((event) => {
      let summary = "";
      if (event.type === "message.delta") {
        summary = `delta=${JSON.stringify(event.delta?.slice(0, 30))}`;
      } else if (event.type === "reasoning.message.chunk") {
        summary = `text=${JSON.stringify(event.text?.slice(0, 30))}`;
      } else if (event.type === "tool_call.start") {
        summary = `tool=${event.toolCallName}`;
      } else if (event.type === "tool_call.end") {
        summary = `id=${event.toolCallId} status=${event.status ?? "?"}`;
      } else if (event.type === "plan.updated") {
        summary = `entries=${event.entries.length}`;
      } else if (event.type === "commands.updated") {
        summary = `commands=${event.commands.length}`;
      } else if (event.type === "mode.changed") {
        summary = `modeId=${event.modeId}`;
      } else if (event.type === "usage.updated") {
        summary = `used=${event.used}/${event.size}`;
      } else if (event.type === "task.status.updated") {
        const md = (event.update.metadata as { kind?: string } | undefined)?.kind;
        const txt = event.update.status.message?.parts
          ?.filter((p) => p.kind === "text")
          .map((p) => (p as { text: string }).text)
          .join("");
        summary = `kind=${md ?? "(none)"} text=${JSON.stringify((txt ?? "").slice(0, 40))}`;
      }
      events.push({ ts: Date.now() - startedAt, type: event.type, summary });
    });

    const controller = new A2AClientController({ provider });
    controller.subscribe((_event, nextState) => {
      state = nextState;
    });

    await controller.connect({ url: `http://127.0.0.1:${PORT}` });
    console.log("[verify] connected");

    console.log("[verify] sendTurn:", PROMPT);
    await controller.sendTurn(PROMPT, { poll: false, signal: AbortSignal.timeout(TIMEOUT_MS) });

    // Print timeline
    console.log("\n=== EVENT TIMELINE ===");
    for (const e of events) {
      const tag = e.type.padEnd(28);
      console.log(`+${String(e.ts).padStart(6)}ms  ${tag}  ${e.summary}`);
    }

    // Verify expectations
    const hasThought = events.some((e) => e.type === "reasoning.message.chunk");
    const hasMessageDelta = events.some((e) => e.type === "message.delta");
    const firstThought = events.findIndex((e) => e.type === "reasoning.message.chunk");
    const firstDelta = events.findIndex((e) => e.type === "message.delta");
    const thoughtBeforeText = firstThought !== -1 && firstDelta !== -1 && firstThought < firstDelta;

    console.log("\n=== FINAL SESSION STATE ===");
    console.log(`pendingAgentText:     ${(state.pendingAgentText ?? "").slice(0, 80)}…`);
    console.log(`pendingThoughtText:   ${(state.pendingThoughtText ?? "").slice(0, 80)}…`);
    console.log(`activeToolCalls:      ${state.activeToolCalls.length}`);
    console.log(`completedToolCalls:   ${state.completedToolCalls.length}`);
    console.log(`currentPlan:          ${state.currentPlan?.length ?? "null"}`);
    console.log(`availableCommands:    ${state.availableCommands.length}`);
    console.log(`currentMode:          ${state.currentMode?.modeId ?? "null"}`);
    console.log(
      `lastUsage:            ${state.lastUsage ? `${state.lastUsage.used}/${state.lastUsage.size}` : "null"}`,
    );

    console.log("\n=== ASSERTIONS ===");
    const checks: Array<[string, boolean]> = [
      ["received reasoning.message.chunk events", hasThought],
      ["received message.delta events", hasMessageDelta],
      ["thought arrived before first text delta", thoughtBeforeText],
    ];
    let allPass = true;
    for (const [label, pass] of checks) {
      console.log(`${pass ? "✓" : "✗"} ${label}`);
      if (!pass) allPass = false;
    }

    if (!allPass) {
      console.error("\n[verify] FAILED");
      process.exit(1);
    }
    console.log("\n[verify] PASS — wire surface end-to-end working");
  } finally {
    serveProc.kill("SIGTERM");
  }
}

main().catch((e) => {
  console.error("[verify] error:", e);
  process.exit(1);
});
