#!/usr/bin/env bun
/**
 * SSE batching reproducer harness.
 *
 * Self-contained: imports nothing from agents-js, no SDK, no harness.
 * Goal: bisect which layer between Bun.serve `controller.enqueue` and
 * a client's read loop coalesces SSE chunks into one batch. Gates G1,
 * G2 (Bun+Node), G3, G5 are wired here; G4 (Bun version matrix) is a
 * manual rerun under different Bun versions, and G2's undici client
 * variant is omitted because Node 24's native fetch covers the non-Bun
 * comparison without adding a runtime dep.
 *
 * Usage:
 *   bun scripts/sse-batching-repro.ts                # default: run all gates, print verdict
 *   bun scripts/sse-batching-repro.ts serve          # just run the SSE server (port 6977)
 *   bun scripts/sse-batching-repro.ts client-bun     # run one client against an existing server
 *   bun scripts/sse-batching-repro.ts client-bun-raw # bypass line-parser, raw byte timestamps (G5)
 *   bun scripts/sse-batching-repro.ts client-node    # Node 24 native fetch via subprocess (G2)
 *   bun scripts/sse-batching-repro.ts client-curl    # curl -N (G3, kernel-level)
 *
 * Flags:
 *   --port=N           port for server / target for clients (default 6977)
 *   --events=N         server: number of events to emit (default 10)
 *   --interval=N       server: ms between emits (default 1000)
 *   --threshold=N      client: ms below which inter-arrival is "batched" (default 200)
 *   --payload-bytes=N  server: pad each event with N bytes (default 0)
 *   --shape=NAME       server: 'minimal' or 'agents-js' SSE frame shape (default minimal)
 *   --burst            server: emit all events with `await Bun.sleep(0)` (yield to event
 *                      loop, no real delay) — exercises Bun.serve's write-coalescing
 */
import { spawn } from "node:child_process";

interface Args {
  command: string;
  port: number;
  events: number;
  intervalMs: number;
  thresholdMs: number;
  payloadBytes: number;
  shape: "minimal" | "agents-js";
  burst: boolean;
  direct: boolean;
  url: string;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const command = args.find((a) => !a.startsWith("--")) ?? "all";
  const flag = (name: string, fallback: string) =>
    args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
  const port = Number(flag("port", "6977"));
  const shape = flag("shape", "minimal");
  if (shape !== "minimal" && shape !== "agents-js") {
    throw new Error(`--shape must be 'minimal' or 'agents-js', got ${shape}`);
  }
  return {
    command,
    port,
    events: Number(flag("events", "10")),
    intervalMs: Number(flag("interval", "1000")),
    thresholdMs: Number(flag("threshold", "200")),
    payloadBytes: Number(flag("payload-bytes", "0")),
    shape,
    burst: args.includes("--burst"),
    direct: args.includes("--direct"),
    url: `http://127.0.0.1:${port}/sse`,
  };
}

interface Arrival {
  ts: number;
  payload: string;
}

interface ClientResult {
  label: string;
  arrivals: Arrival[];
  startedAt: number;
  finishedAt: number;
}

function summarize(result: ClientResult, expectedCount: number, thresholdMs: number) {
  const deltas: number[] = [];
  for (let i = 1; i < result.arrivals.length; i++) {
    const cur = result.arrivals[i];
    const prev = result.arrivals[i - 1];
    if (cur && prev) deltas.push(cur.ts - prev.ts);
  }
  const minDelta = deltas.length ? Math.min(...deltas) : 0;
  const maxDelta = deltas.length ? Math.max(...deltas) : 0;
  const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const batched = deltas.filter((d) => d < thresholdMs).length;
  const verdict =
    result.arrivals.length < expectedCount
      ? "INCOMPLETE"
      : batched / Math.max(deltas.length, 1) > 0.5
        ? "BATCHED"
        : "STREAMING";
  return {
    ...result,
    deltas,
    minDelta,
    maxDelta,
    meanDelta,
    batched,
    verdict,
  };
}

function fmt(ms: number) {
  return `${Math.round(ms)}ms`;
}

// ---------------------------------------------------------------------------
// Server (G1) — minimal Bun.serve emitter, mirrors agents-js's SSE headers
// ---------------------------------------------------------------------------

async function runServer(args: Args, signal?: AbortSignal): Promise<void> {
  const { port, events, intervalMs } = args;
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/sse") {
        return new Response("not found", { status: 404 });
      }
      const padding = "x".repeat(args.payloadBytes);
      const buildFrame = (i: number) => {
        const data = JSON.stringify({ n: i, enqueueAt: performance.now(), pad: padding });
        return args.shape === "agents-js"
          ? `event: status-update\ndata: ${data}\nid: msg-${i}\n\n`
          : `data: ${data}\n\n`;
      };
      const headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      };
      if (args.direct) {
        return new Response(
          new ReadableStream({
            type: "direct",
            async pull(controller) {
              for (let i = 0; i < events; i++) {
                if (i > 0) {
                  if (args.burst) await Bun.sleep(0);
                  else await Bun.sleep(intervalMs);
                }
                controller.write(buildFrame(i));
                // controller.flush() returns a synchronous byte count, not a Promise.
                // Calling without await preserves the sync semantics under test
                // (await would schedule a microtask that flush itself doesn't need).
                controller.flush();
              }
              controller.close();
            },
          } as UnderlyingSource),
          { headers },
        );
      }
      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          for (let i = 0; i < events; i++) {
            if (i > 0) {
              if (args.burst) await Bun.sleep(0);
              else await Bun.sleep(intervalMs);
            }
            controller.enqueue(encoder.encode(buildFrame(i)));
          }
          controller.close();
        },
      });
      return new Response(stream, { headers });
    },
  });
  console.log(
    `[server] listening http://127.0.0.1:${port}/sse — ${events} events, ${intervalMs}ms interval`,
  );
  if (signal) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        server.stop(true);
        resolve();
      });
    });
  } else {
    await new Promise<void>(() => {}); // run forever
  }
}

// ---------------------------------------------------------------------------
// Client variants
// ---------------------------------------------------------------------------

/** G2-bun: Bun's native fetch, parseSseStream-equivalent line buffering. */
async function clientBun(args: Args): Promise<ClientResult> {
  const arrivals: Arrival[] = [];
  const startedAt = performance.now();
  const res = await fetch(args.url);
  if (!res.body) throw new Error("no response body");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let newlineIdx = buffer.indexOf("\n\n");
    while (newlineIdx >= 0) {
      const block = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 2);
      newlineIdx = buffer.indexOf("\n\n");
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        arrivals.push({ ts: performance.now() - startedAt, payload: dataLine.slice(6) });
      }
    }
  }
  return { label: "bun-fetch+parser", arrivals, startedAt, finishedAt: performance.now() };
}

/** G5: same Bun fetch but bypass line buffering — timestamp raw byte chunks. */
async function clientBunRaw(args: Args): Promise<ClientResult> {
  const arrivals: Arrival[] = [];
  const startedAt = performance.now();
  const res = await fetch(args.url);
  if (!res.body) throw new Error("no response body");
  const reader = res.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    arrivals.push({
      ts: performance.now() - startedAt,
      payload: `bytes=${value?.byteLength ?? 0}`,
    });
  }
  return { label: "bun-fetch-raw", arrivals, startedAt, finishedAt: performance.now() };
}

/** G2-node: Node 24's native fetch via subprocess. */
async function clientNode(args: Args): Promise<ClientResult> {
  const startedAt = performance.now();
  const code = `
    const url = ${JSON.stringify(args.url)};
    const startedAt = performance.now();
    const res = await fetch(url);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let i;
      while ((i = buffer.indexOf("\\n\\n")) >= 0) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const data = block.split("\\n").find(l => l.startsWith("data: "));
        if (data) console.log(JSON.stringify({ ts: performance.now() - startedAt, payload: data.slice(6) }));
      }
    }
  `;
  const arrivals = await runSubprocessClient("node", ["--input-type=module", "-e", code]);
  return { label: "node-fetch+parser", arrivals, startedAt, finishedAt: performance.now() };
}

/** G3: curl -N — kernel-level wire timestamps, rules out runtime + decoder. */
async function clientCurl(args: Args): Promise<ClientResult> {
  const startedAt = performance.now();
  const arrivals: Arrival[] = [];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("curl", ["-sN", args.url], { stdio: ["ignore", "pipe", "ignore"] });
    let buffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let i = buffer.indexOf("\n\n");
      while (i >= 0) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine)
          arrivals.push({ ts: performance.now() - startedAt, payload: dataLine.slice(6) });
        i = buffer.indexOf("\n\n");
      }
    });
    proc.on("close", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`curl exited with code ${code}`));
    });
    proc.on("error", reject);
  });
  return { label: "curl -N", arrivals, startedAt, finishedAt: performance.now() };
}

async function runSubprocessClient(cmd: string, cmdArgs: string[]): Promise<Arrival[]> {
  const arrivals: Arrival[] = [];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let i = buffer.indexOf("\n");
      while (i >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) {
          try {
            arrivals.push(JSON.parse(line));
          } catch {
            // ignore non-JSON noise
          }
        }
        i = buffer.indexOf("\n");
      }
    });
    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });
    proc.on("close", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderrBuf.slice(0, 200)}`));
    });
    proc.on("error", reject);
  });
  return arrivals;
}

// ---------------------------------------------------------------------------
// Orchestrator — `all` runs server + every client in sequence
// ---------------------------------------------------------------------------

async function runAll(args: Args) {
  const ctrl = new AbortController();
  const serverP = runServer(args, ctrl.signal);
  await Bun.sleep(200); // let server bind

  const totalRunMs = args.events * args.intervalMs + 2000;

  const variants: Array<[string, () => Promise<ClientResult>]> = [
    ["bun-fetch+parser", () => clientBun(args)],
    ["bun-fetch-raw", () => clientBunRaw(args)],
    ["node-fetch+parser", () => clientNode(args)],
    ["curl -N", () => clientCurl(args)],
  ];

  const results = [];
  for (const [label, fn] of variants) {
    console.log(`\n--- ${label} ---`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ClientResult>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), totalRunMs * 2);
    });
    const result = (await Promise.race([fn(), timeout])
      .catch((e) => ({
        label,
        arrivals: [],
        startedAt: 0,
        finishedAt: 0,
        error: String(e),
      }))
      .finally(() => {
        if (timer) clearTimeout(timer);
      })) as ClientResult & { error?: string };

    if ("error" in result && result.error) {
      console.log(`  ERROR: ${result.error}`);
      results.push({ label, verdict: "ERROR", error: result.error });
      continue;
    }
    const summary = summarize(result, args.events, args.thresholdMs);
    for (const a of summary.arrivals) {
      console.log(`  +${String(Math.round(a.ts)).padStart(6)}ms  ${a.payload}`);
    }
    console.log(
      `  → ${summary.arrivals.length}/${args.events} arrivals; deltas min=${fmt(summary.minDelta)} mean=${fmt(summary.meanDelta)} max=${fmt(summary.maxDelta)}; verdict=${summary.verdict}`,
    );
    results.push({
      label,
      verdict: summary.verdict,
      arrivals: summary.arrivals.length,
      meanDelta: summary.meanDelta,
    });
  }

  ctrl.abort();
  await serverP.catch(() => {});

  console.log("\n=== VERDICT ===");
  console.log(`Bun ${Bun.version}; expected per-event interval ${args.intervalMs}ms`);
  console.log("client                arrivals   meanΔ      verdict");
  console.log("--------------------- ---------- ---------- ----------");
  for (const r of results) {
    const arr = "arrivals" in r ? `${r.arrivals}/${args.events}` : "—";
    const mean = "meanDelta" in r && r.meanDelta != null ? fmt(r.meanDelta) : "—";
    console.log(`${r.label.padEnd(21)} ${arr.padEnd(10)} ${mean.padEnd(10)} ${r.verdict}`);
  }

  console.log("\n=== INTERPRETATION ===");
  const labelVerdict = (l: string) => results.find((r) => r.label === l)?.verdict;
  const bunFetch = labelVerdict("bun-fetch+parser");
  const bunRaw = labelVerdict("bun-fetch-raw");
  const node = labelVerdict("node-fetch+parser");
  const curl = labelVerdict("curl -N");

  if (curl === "BATCHED") {
    console.log(
      "• curl shows batching → server-side or kernel-level coalescing. Suspect Bun.serve outbound.",
    );
  } else if (
    bunRaw === "BATCHED" &&
    bunFetch === "BATCHED" &&
    node !== "BATCHED" &&
    curl !== "BATCHED"
  ) {
    console.log(
      "• Only Bun fetch coalesces (raw + parsed); Node + curl stream → ROOT CAUSE: Bun's fetch client.",
    );
  } else if (bunRaw !== "BATCHED" && bunFetch === "BATCHED") {
    console.log(
      "• Raw bytes stream but parsed events coalesce → ROOT CAUSE: parseSseStream / TextDecoderStream.",
    );
  } else if ([bunFetch, bunRaw, node, curl].every((v) => v === "STREAMING")) {
    console.log(
      "• All clients stream → cannot reproduce locally. Real-world bug needs the full agents-js path.",
    );
  } else {
    console.log(
      "• Mixed signal — see per-client deltas above. Re-run with --events=20 --interval=500 for more data.",
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "serve":
      await runServer(args);
      break;
    case "client-bun":
      console.log(
        JSON.stringify(summarize(await clientBun(args), args.events, args.thresholdMs), null, 2),
      );
      break;
    case "client-bun-raw":
      console.log(
        JSON.stringify(summarize(await clientBunRaw(args), args.events, args.thresholdMs), null, 2),
      );
      break;
    case "client-node":
      console.log(
        JSON.stringify(summarize(await clientNode(args), args.events, args.thresholdMs), null, 2),
      );
      break;
    case "client-curl":
      console.log(
        JSON.stringify(summarize(await clientCurl(args), args.events, args.thresholdMs), null, 2),
      );
      break;
    case "all":
      await runAll(args);
      break;
    default:
      console.error(`unknown command: ${args.command}`);
      process.exit(1);
  }
}

await main();
