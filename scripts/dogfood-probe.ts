#!/usr/bin/env bun
/**
 * Multi-agent dogfood wire probe (#72).
 *
 * Drives a `agents-js serve` already running on the given URL with a
 * prompt that's likely to trigger tool calls, captures all A2AEvents,
 * and prints a structured timeline plus pass/fail assertions over the
 * wire-kinds extensions from PR #35 (toolKind, content, locations,
 * rawInput, rawOutput). Hard-asserts on toolKind, locations|rawInput,
 * terminal status, and rawOutput. `content` is harness-dependent
 * (codex emits raw process output, claude/pi may emit content blocks)
 * — surfaced as informational only so the gate doesn't false-fail
 * across harnesses.
 *
 * Usage:
 *   bun scripts/dogfood-probe.ts <url> "<prompt>" [--verbose]
 *
 * **Credential-leak note**: ACP `rawInput`/`rawOutput`/`content` fields
 * are unredacted by spec — they may include API keys, file contents,
 * tokens, or private paths. By default this probe prints presence
 * markers (`rawInput=<set>`) only. `--verbose` opts into printing
 * truncated JSON of every field, but the output then risks landing in
 * terminal scrollback or CI logs. Default-safe.
 */
import { A2AClientController } from "@agents-js/a2a-client";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const positional = args.filter((a) => !a.startsWith("--"));
const url = positional[0];
const prompt =
  positional[1] ?? "Read packages/a2a/src/wire-kinds.ts. Tell me what kinds are defined.";

if (!url) {
  console.error("usage: bun scripts/dogfood-probe.ts <url> [prompt] [--verbose]");
  process.exit(1);
}

/** Field-presence marker. With `--verbose`, includes a truncated JSON
 *  preview; otherwise just `<set>` so secret-bearing payloads don't
 *  end up in scrollback or CI logs. */
function fieldMarker(label: string, value: unknown, charLimit = 80): string {
  if (!verbose) return `${label}=<set>`;
  return `${label}=${JSON.stringify(value).slice(0, charLimit)}`;
}

const controller = new A2AClientController();
const events: Array<{ ts: number; type: string; summary: string }> = [];
const startedAt = Date.now();

controller.subscribe((event) => {
  let summary = "";
  if (event.type === "tool_call.start") {
    const fields: string[] = [`id=${event.toolCallId}`, `tool=${event.toolCallName}`];
    if (event.toolKind !== undefined) fields.push(`toolKind=${event.toolKind}`);
    if (event.content !== undefined) fields.push(fieldMarker("content", event.content));
    if (event.locations !== undefined) fields.push(fieldMarker("locations", event.locations));
    if (event.rawInput !== undefined) fields.push(fieldMarker("rawInput", event.rawInput));
    summary = fields.join(" ");
  } else if (event.type === "tool_call.progress") {
    const fields: string[] = [`id=${event.toolCallId}`, `status=${event.status ?? "?"}`];
    if (event.content !== undefined) fields.push(fieldMarker("content", event.content));
    if (event.rawOutput !== undefined) fields.push(fieldMarker("rawOutput", event.rawOutput));
    summary = fields.join(" ");
  } else if (event.type === "tool_call.end") {
    const fields: string[] = [`id=${event.toolCallId}`, `status=${event.status ?? "?"}`];
    if (event.toolKind !== undefined) fields.push(`toolKind=${event.toolKind}`);
    if (event.content !== undefined) fields.push(fieldMarker("content", event.content));
    if (event.rawOutput !== undefined) fields.push(fieldMarker("rawOutput", event.rawOutput));
    summary = fields.join(" ");
  } else if (event.type === "message.delta") {
    // Message text is user-visible; safe to preview short prefix.
    summary = `delta=${JSON.stringify(event.delta?.slice(0, 40))}`;
  } else if (event.type === "reasoning.message.chunk") {
    summary = `text=${JSON.stringify(event.text?.slice(0, 40))}`;
  } else if (event.type === "plan.updated") {
    summary = `entries=${event.entries.length}`;
  } else if (event.type === "commands.updated") {
    summary = `commands=${event.commands.length}`;
  } else if (event.type === "mode.changed") {
    summary = `modeId=${event.modeId}`;
  } else if (event.type === "usage.updated") {
    summary = `${event.used}/${event.size}`;
  } else if (event.type === "session.info.updated") {
    summary = `title=${event.title} updatedAt=${event.updatedAt}`;
  }
  events.push({ ts: Date.now() - startedAt, type: event.type, summary });
});

console.log(`[probe] connecting to ${url}${verbose ? " (verbose)" : ""}`);
await controller.connect({ url });
console.log(`[probe] sending: ${prompt}`);
// Omit `poll` so sendTurn picks the right termination strategy: streaming
// when the target supports it, polling otherwise. Hard-coding `poll:false`
// could return before terminal state when streaming is unavailable, missing
// the tool_call lifecycle assertions below.
await controller.sendTurn(prompt, { signal: AbortSignal.timeout(180_000) });

console.log("\n=== EVENT TIMELINE ===");
for (const e of events) {
  if (e.summary || ["turn.started", "message.completed", "task.updated"].includes(e.type)) {
    console.log(`+${String(e.ts).padStart(6)}ms  ${e.type.padEnd(28)}  ${e.summary}`);
  }
}

const toolCallStarts = events.filter((e) => e.type === "tool_call.start");
const toolCallEnds = events.filter((e) => e.type === "tool_call.end");
const toolCallProgress = events.filter((e) => e.type === "tool_call.progress");

console.log("\n=== WIRE-KINDS FIDELITY ASSERTIONS ===");
const allToolCallEvents = [...toolCallStarts, ...toolCallProgress, ...toolCallEnds];
const checks: Array<[string, boolean]> = [
  [`tool_call.start emitted at least once`, toolCallStarts.length >= 1],
  [`tool_call.start carries toolKind`, toolCallStarts.some((e) => e.summary.includes("toolKind="))],
  [
    `tool_call.start carries locations OR rawInput`,
    toolCallStarts.some((e) => e.summary.includes("locations=") || e.summary.includes("rawInput=")),
  ],
  [`tool_call.end emitted at least once`, toolCallEnds.length >= 1],
  [
    `tool_call.end status terminal`,
    toolCallEnds.some(
      (e) =>
        e.summary.includes("status=completed") ||
        e.summary.includes("status=failed") ||
        e.summary.includes("status=cancelled"),
    ),
  ],
  [
    `tool_call.end OR tool_call.progress carries rawOutput`,
    [...toolCallEnds, ...toolCallProgress].some((e) => e.summary.includes("rawOutput=")),
  ],
];

let pass = 0;
let fail = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (ok) pass++;
  else fail++;
}
console.log(`\n${pass}/${checks.length} pass, ${fail} fail`);

const sawContent = allToolCallEvents.some((e) => e.summary.includes("content="));
console.log(
  `\nstarts=${toolCallStarts.length} progress=${toolCallProgress.length} ends=${toolCallEnds.length}` +
    `  content=${sawContent ? "observed" : "not observed (harness-dependent)"}`,
);
process.exit(fail === 0 ? 0 : 1);
