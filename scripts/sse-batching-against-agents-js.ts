#!/usr/bin/env bun
/**
 * Discriminator: do agents-js's streaming SSE chunks arrive batched
 * client-side, or do they stream at LLM cadence? Tests against a running
 * `agents-js serve` of any harness. Use a real LLM (codex/claude) for
 * meaningful cadence — mock-acp's response completes in ~20ms total,
 * which is too short to differentiate batching from streaming.
 *
 * Usage (real LLM, the meaningful case):
 *   PATH="$PWD/extras/pi-acp/dist:$PATH" \
 *     bun packages/cli/src/cli.ts serve --harness codex --port 6983
 *   bun scripts/sse-batching-against-agents-js.ts http://127.0.0.1:6983
 *
 * Usage (mock-acp — fast / sanity check only):
 *   AGENTS_JS_ENABLE_MOCK_ACP_RUNTIME=1 MOCK_ACP_STREAMING_TEXT=1 \
 *     bun packages/cli/src/cli.ts serve --harness mock-acp --port 6982
 *   bun scripts/sse-batching-against-agents-js.ts http://127.0.0.1:6982
 */
import { randomUUID } from "node:crypto";

const url = process.argv[2] ?? "http://127.0.0.1:6982";

const messageId = randomUUID();

const body = {
  jsonrpc: "2.0",
  id: 1,
  method: "message/stream",
  params: {
    message: {
      role: "user",
      parts: [{ kind: "text", text: "hi" }],
      messageId,
      kind: "message",
    },
  },
};

console.log(`[probe] POST ${url} method=message/stream`);

const startedAt = performance.now();
const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  },
  body: JSON.stringify(body),
});

console.log(
  `[probe] response status=${res.status} t=${Math.round(performance.now() - startedAt)}ms`,
);
console.log(`[probe] headers:`, Object.fromEntries(res.headers.entries()));

if (!res.ok) {
  console.error(`[probe] non-2xx status: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const contentType = res.headers.get("content-type") ?? "";
if (!contentType.startsWith("text/event-stream")) {
  console.error(
    `[probe] content-type is not SSE: ${contentType} — gateway likely returned an error envelope`,
  );
  process.exit(1);
}
if (!res.body) {
  console.error("[probe] no response body");
  process.exit(1);
}

const decoder = new TextDecoder();
const reader = res.body.getReader();
let totalBytes = 0;
let chunks = 0;
const arrivals: Array<{ ts: number; bytes: number; preview: string }> = [];
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  if (!value) continue;
  chunks++;
  totalBytes += value.byteLength;
  const ts = performance.now() - startedAt;
  const preview = decoder.decode(value.slice(0, Math.min(80, value.byteLength)), {
    stream: true,
  });
  arrivals.push({ ts, bytes: value.byteLength, preview });
}

console.log(`\n=== RAW BYTE ARRIVALS ===`);
for (const a of arrivals) {
  const cleanPreview = a.preview.replace(/\n/g, "\\n").slice(0, 60);
  console.log(`+${String(Math.round(a.ts)).padStart(6)}ms  bytes=${a.bytes}  ${cleanPreview}`);
}

const deltas: number[] = [];
for (let i = 1; i < arrivals.length; i++) {
  const cur = arrivals[i];
  const prev = arrivals[i - 1];
  if (cur && prev) deltas.push(cur.ts - prev.ts);
}
const minDelta = deltas.length ? Math.min(...deltas) : 0;
const maxDelta = deltas.length ? Math.max(...deltas) : 0;
const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

console.log(`\n=== SUMMARY ===`);
console.log(`total chunks=${chunks}; bytes=${totalBytes}`);
console.log(
  `deltas: min=${Math.round(minDelta)}ms mean=${Math.round(meanDelta)}ms max=${Math.round(maxDelta)}ms`,
);
const batchedCount = deltas.filter((d) => d < 5).length;
console.log(`< 5ms gaps: ${batchedCount}/${deltas.length}`);
if (deltas.length === 0) {
  console.log(
    "VERDICT: insufficient data — fewer than 2 chunks observed; cannot classify (use a real LLM harness)",
  );
} else if (batchedCount === deltas.length) {
  console.log("VERDICT: all reads landed within 5ms of each other → BATCHED at the wire");
} else if (batchedCount === 0) {
  console.log("VERDICT: every chunk separated by ≥5ms → STREAMING at the wire");
} else {
  console.log(`VERDICT: mixed (${batchedCount}/${deltas.length} gaps under 5ms)`);
}
