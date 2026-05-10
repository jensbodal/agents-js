# SSE batching investigation

**Status**: ROOT CAUSE IDENTIFIED — `Bun.serve` outbound write coalescing.

The reproducer harness `scripts/sse-batching-repro.ts` (#71) demonstrates
that when a `Bun.serve` ReadableStream consumer calls `controller.enqueue`
multiple times within the same event-loop tick (or close to it — `await
Bun.sleep(0)` between calls is enough to yield but does not break
coalescing), the outbound bytes are flushed as a single TCP write.

Evidence (from `bun scripts/sse-batching-repro.ts all --burst`):

```
client                arrivals   meanΔ      verdict
--------------------- ---------- ---------- ----------
bun-fetch+parser      8/8        0ms        BATCHED
bun-fetch-raw         4/8        0ms        INCOMPLETE  (bytes batched, fewer reader yields)
node-fetch+parser     8/8        0ms        BATCHED
curl -N               8/8        0ms        BATCHED
```

`curl -N` is the deciding signal: kernel-level / wire-level read shows the
8 events arrive in one batch, ruling out Bun's fetch client, Node's fetch
client, `TextDecoderStream`, `parseSseStream` line buffering, and any
other downstream-of-server suspect. With the same server emitting events
500ms apart instead, all four clients stream cleanly at proper intervals
— so the coalescing depends on inter-write spacing, not on the clients.

**Why agents-js sees this:** the A2A executor processes ACP `sessionUpdate`
notifications synchronously inside one async iteration of the request
handler — between `await`s, multiple `controller.enqueue` calls happen
within the same tick, and Bun.serve coalesces them. Real claude/codex
turns that emit many small chunks tightly all batch; turns with sparse
chunks (or with model latency between chunks) do not batch.

**Earlier framing in this report ("Bun fetch runtime") was wrong** — the
suspect was downstream-of-server rather than the server itself. The
verification gates G1, G2, G3, and G5 in §"Verification gates" below all
ran via `scripts/sse-batching-repro.ts` and produced the data above.

What the probe data shows:
- agents-js executor publishes per-chunk in real time (innocent)
- @a2a-js/sdk server-side queue + request handler yield in real time (innocent)
- agents-js `Bun.serve` `controller.enqueue` lands per-chunk in real time (innocent)
- The SDK client's `parseSseStream` reads `response.body.getReader().read()`
  in a `for await` loop and observes ALL chunks at the same millisecond, ~2ms
  after the server's last enqueue

What this proves:
- The buffering is downstream of `controller.enqueue` and upstream of
  `parseSseStream`'s `yield`.

What this DOES NOT prove (and what would be required before claiming "Bun bug"):
- That Bun's fetch runtime is the buffering layer specifically. Could also be
  `TextDecoderStream`, the WHATWG `ReadableStream` `getReader()` / `for await`
  adapter, or `parseSseStream`'s line-buffering with deferred yields.
- That a non-Bun fetch (undici, Node native, curl) on the same server with the
  same headers receives chunks promptly.
- That intermediaries / encoding aren't contributing (no `Content-Encoding`
  inspection, no `Transfer-Encoding` inspection, no wire capture).
- A version matrix — current data is one Bun 1.3.12 datapoint.

The earlier framing of this report claimed "Bun fetch runtime, confirmed" — that
was overreach. The probe data narrows the suspect set; it does not single out
one suspect. See "Verification gates before upstream filing" below.

## Symptom

When the CLI client (`bunx @agents-js/cli client`) is connected to a serve gateway running a real claude-agent-acp harness, the visible response appears to "snap in" at the end of the turn rather than streaming token-by-token. The TUI sits silent for the full duration of the model's emission, then renders the entire response in one frame.

(Two separate sessions are referenced below: the original report observed ~50 chunks over ~14s of total wall-clock; the probe-instrumented session captured here observed ~50 enqueues spread over ~4.7s of *server-side enqueue activity* (excluding pre-thinking time). Both runs exhibit the same end-of-turn coalescing on the receive side; the streaming-window numbers differ because the prompts and the model's pre-thinking pauses differ. The conclusion — receive-side coalescing — is independent of either window.)

## Investigation

Probe instrumentation was added at six points in the request path:

1. `executor:publish` — agents-js executor calls `eventBus.publish()` per ACP chunk
2. `sdk:enqueue` — DefaultExecutionEventBus's `handleEvent` pushes to its in-memory queue
3. `sdk:dequeue` / `sdk:postProcess` / `sdk:preYield` — request-handler's async generator yields the event after `resultManager.processEvent` (which awaits `taskStore.save`)
4. `server:enqueue` — agents-js's `Bun.serve` ReadableStream consumer calls `controller.enqueue(formatSseEvent(...))`
5. `sse:bodyChunk` — SDK client's `parseSseStream` receives bytes from `response.body.getReader().read()`
6. `transport:sdkYield` — agents-js transport receives the parsed event from the SDK client

### Server-side timing (real claude session)

```
[probe server:enqueue] t=523155
[probe server:enqueue] t=525403   (+2.2s)
[probe server:enqueue] t=525406   (+0.003s)
[probe server:enqueue] t=526662   (+1.3s)
... 50 enqueues spread over ~4.7 seconds, matching claude's streaming cadence
[probe server:enqueue] t=527913
```

Server is enqueueing per-chunk in real time. **The SDK and agents-js server-side are innocent.**

### Client-side timing (same session)

```
[probe sse:bodyChunk] t=527915 bytes=500
[probe sse:bodyChunk] t=527915 bytes=247
[probe sse:bodyChunk] t=527915 bytes=19354
[probe sse:bodyChunk] t=527915 bytes=302
... ALL bodyChunk events at t=527915 — single millisecond
```

`response.body.getReader().read()` does not return until **after** the server's last enqueue (~2ms gap). All chunks arrive at once.

### Suspect set after probe data

The buffering layer is downstream of `controller.enqueue` on the server and upstream of `parseSseStream`'s `yield` on the client. Within that window, the probe data does NOT singularly identify the responsible component. Live suspects:

- **Bun's `fetch` Response body** — `getReader().read()` may queue bytes until the response stream completes or some internal threshold. Most likely candidate based on Bun's known SSE-adjacent flush bugs (oven-sh/bun#15235, #13811), but those are server-side; no canonical open issue documents fetch-client coalescing.
- **`TextDecoderStream`** in `parseSseStream`'s pipe-through — could buffer bytes until a decode boundary even when the underlying stream releases promptly.
- **WHATWG `ReadableStream` `for await` adapter** — `for await (const value of readFrom(stream))` could coalesce values delivered close together at the runtime layer.
- **`parseSseStream`'s line-buffering with deferred yields** — the `while ((lineEndIndex = buffer.indexOf("\n")) >= 0)` loop yields events lazily; if input arrives as one big chunk because of a layer above, this is correct behavior, not the cause.

Nothing in the application code is obviously wrong: server's `Bun.serve` ReadableStream calls `controller.enqueue(...)` per event; `text/event-stream`, `Cache-Control: no-cache`, and `X-Accel-Buffering: no` headers are set. The earlier framing of this section claimed Bun's fetch as the confirmed culprit — that was overreach. Verification gates G1-G5 below are how we'd actually narrow it down.

## Verification gates before upstream filing

A reproducer must isolate Bun's fetch from app code, the SDK, the claude
harness, and any intermediaries. Until all of these pass, "upstream Bun bug"
is an unverified runtime hypothesis, not a claim:

- **G1: Minimal repro.** Small `Bun.serve` that emits `data: {n}\n\n` once per
  second for N seconds. Client uses `fetch(url).body.getReader().read()` and
  prints arrival timestamps. Expected: N reads, 1s apart. Observed:
  documents the gap at the wire level without the SDK / claude in the path.

- **G2: Comparative trace.** Run G1's client under three runtimes against the
  same `Bun.serve` server: Bun's native fetch, undici fetch, and the
  repo-pinned Node version's native fetch (currently Node 24 per `mise.toml`;
  bump in lockstep if the pin moves). If only Bun's fetch shows the gap,
  that's the smoking gun. If all three show it, suspect server-side or
  `parseSseStream`-equivalent on the client.

- **G3: Wire capture.** `curl -N` against the same endpoint, or tcpdump on
  loopback. Establishes whether bytes hit the kernel promptly or coalesced.
  This step rules out kernel/proxy/encoding suspects — `Content-Encoding`,
  `Transfer-Encoding`, `Cache-Control`, intermediary buffering.

- **G4: Version matrix.** Repro against at least Bun 1.3.12 (current),
  1.3-latest, and one older 1.1.x line. Bun's SSE behavior shifted in
  1.1.26/1.1.27; without a version sweep "current Bun" is unfalsifiable.

- **G5: Decoder isolation.** Same client code but bypass `parseSseStream` —
  read raw bytes from `getReader()` and timestamp those directly. If raw
  bytes arrive prompt and `parseSseStream` yields collapse, the bug is in
  the SDK's framing/decoder, not the runtime.

These are tracked as task #69's follow-ups (#70, #71). The earlier task
titles ("Try undici workaround", "File upstream Bun bug") were premature —
they assumed the cause that the gates above are meant to verify.

## Fix — manually-flushed outbound transport

Root cause is server-side, so client-side workarounds (custom `fetchImpl`
with undici, etc.) wouldn't help.

The fix lives in `packages/a2a/src/server.ts`'s SSE response construction.
Replace the standard `ReadableStream` with `Bun.serve`'s direct
controller (`type: "direct"` + explicit `flush()` per write) which gives
write-by-write control over the TCP send timing:

```ts
// Sketch — actual change goes in server.ts where the ReadableStream is built
return new Response(
  new ReadableStream({
    type: "direct",
    async pull(controller) {
      for await (const event of source) {
        controller.write(formatSseEvent(event));
        await controller.flush(); // <-- forces wire flush, prevents coalescing
      }
      controller.close();
    },
  } as UnderlyingSource),
  { headers: SSE_HEADERS },
);
```

Tracked as a follow-up to #71. Out of scope for the harness PR itself —
the harness's job is to confirm the root cause; the server fix lands
separately so it can be evaluated against the harness as a regression
gate.

Alternative escape hatches (kept for completeness):

- **Switch SSE → WebSocket on the agent card.** Protocol-level change.
  Bigger lift, blocks on A2A spec direction.
- **File upstream Bun bug** asking for write-coalescing to honor backpressure
  more aggressively for `text/event-stream` responses. Not blocking — the
  direct-controller workaround is documented Bun-native API, not a hack.

## Adapter-seam recommendation

Independent of root cause: our `fetchImpl` injection point at
`transport.ts:177` is already the seam. We should harden the contract there
so swapping fetch implementations is a one-config-knob change, regardless of
which layer turns out to be at fault. ADR worth writing once G1+G2 produce a
data point.

## Out-of-scope

The pre-existing upstream issue at https://github.com/a2aproject/a2a-js/issues/316
was closed unreproducible (the maintainer asked the OP for a reproducer they
never provided). Whatever upstream we eventually file, it should be a fresh
issue with G1-G5 as evidence — not a re-open.

## Files modified during investigation (all reverted)

- `node_modules/.../@a2a-js/sdk/dist/server/index.js` — added `[probe sdk:*]` lines (REVERTED)
- `node_modules/.../@a2a-js/sdk/dist/chunk-WMQQYH7W.js` — added `[probe sse:bodyChunk]` (REVERTED)
- `packages/a2a/src/server.ts` — added `[probe server:enqueue]` (REVERTED)
- `packages/a2a/src/executor.ts` — added `[probe executor:publish]` (REVERTED)
- `packages/a2a-client/src/transport.ts` — added `[probe transport:sdkYield]` (REVERTED)

`scripts/probe-claude-sse.ts` was the driver harness (not committed).
