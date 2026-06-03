import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createGatewayTestServer, type GatewayTestServerHandle } from "../src/testing.ts";

const MOCK_AGENT = resolve(import.meta.dir, "../../../tests/mock-acp-agent.cjs");

describe("gateway executor — concurrent request handling", () => {
  let handle: GatewayTestServerHandle;

  beforeEach(async () => {
    handle = await createGatewayTestServer({
      acpCommand: "node",
      acpArgs: [MOCK_AGENT],
    });
  });

  afterEach(async () => {
    await handle.stop();
  });

  async function sendMessage(text: string, contextId?: string): Promise<Response> {
    // A2A 1.0 proto-canonical wire shape: `SendMessage` RPC, `role` enum
    // string, parts as proto JSON (`{ text }`), `returnImmediately: false`
    // for blocking semantics.
    return fetch(`${handle.url}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "SendMessage",
        params: {
          tenant: "",
          message: {
            messageId: crypto.randomUUID(),
            role: "ROLE_USER",
            parts: [{ text, mediaType: "text/plain" }],
            ...(contextId ? { contextId } : {}),
          },
          configuration: { returnImmediately: false },
        },
      }),
    });
  }

  test("serial message/send calls both succeed", async () => {
    const response1 = await sendMessage("hello first");
    expect(response1.ok).toBe(true);

    const response2 = await sendMessage("hello second");
    expect(response2.ok).toBe(true);
  }, 10000);

  test("concurrent message/send calls are serialized by the mutex", async () => {
    // Regression guard: without the single-slot mutex, concurrent requests
    // would hang or spawn multiple sessions against a controller that only
    // accepts one prompt at a time.
    const promises = Array.from({ length: 5 }, (_, i) => sendMessage(`concurrent request ${i}`));

    const responses = await Promise.all(promises);
    for (const response of responses) {
      expect(response.ok).toBe(true);
    }
  }, 10000);

  test("same contextId concurrent calls dedup to single underlying prompt", async () => {
    const contextId = `test-ctx-${crypto.randomUUID()}`;
    const promises = Array.from({ length: 3 }, () => sendMessage("duplicate request", contextId));

    const responses = await Promise.all(promises);
    for (const response of responses) {
      expect(response.ok).toBe(true);
    }

    // Regression guard for the mutex-dedup contract: concurrent joiners on the
    // same contextId must republish the owner's outcome WITHOUT a second
    // session/prompt against the underlying ACP agent. Probe the mock's
    // promptCount counter via the `__PROMPT_COUNT__` diagnostic prompt (does
    // not itself increment the counter).
    const probe = await sendMessage("__PROMPT_COUNT__");
    expect(probe.ok).toBe(true);
    const probeBodyText = JSON.stringify(await probe.json());
    const match = probeBodyText.match(/__PROMPT_COUNT__:(\d+)/);
    expect(match).not.toBeNull();
    expect(Number((match as RegExpMatchArray)[1])).toBe(1);
  }, 10000);

  test("concurrent different contextIds run in parallel with per-lane controllers", async () => {
    // Phase-2 regression guard: with a per-contextId controller factory
    // wired in, two distinct contextIds each get their own ACPSessionController
    // and their `__SLEEP_MS__` prompts overlap in wall-clock time. Serializing
    // the factory output back against a shared gate (e.g. restoring
    // `controllerBusy` for all lanes) would push elapsed time close to
    // `SLEEP_MS * 2`.
    //
    // The mock-agent `__SLEEP_MS__:<ms>:<tag>` directive holds each prompt
    // open for <ms> before replying — see `tests/mock-acp-agent.cjs`.
    const parallelHandle = await createGatewayTestServer({
      acpCommand: "node",
      acpArgs: [MOCK_AGENT],
      enablePerLaneControllers: true,
    });
    try {
      const ctxA = `ctx-A-${crypto.randomUUID()}`;
      const ctxB = `ctx-B-${crypto.randomUUID()}`;
      const SLEEP_MS = 500;

      async function sendTo(url: string, text: string, contextId: string): Promise<Response> {
        return fetch(`${url}/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: crypto.randomUUID(),
            method: "SendMessage",
            params: {
              tenant: "",
              message: {
                messageId: crypto.randomUUID(),
                role: "ROLE_USER",
                parts: [{ text, mediaType: "text/plain" }],
                contextId,
              },
              configuration: { returnImmediately: false },
            },
          }),
        });
      }

      const start = Date.now();
      const [respA, respB] = await Promise.all([
        sendTo(parallelHandle.url, `__SLEEP_MS__:${SLEEP_MS}:ALPHA`, ctxA),
        sendTo(parallelHandle.url, `__SLEEP_MS__:${SLEEP_MS}:BETA`, ctxB),
      ]);
      const elapsed = Date.now() - start;

      expect(respA.ok).toBe(true);
      expect(respB.ok).toBe(true);

      const bodyA = JSON.stringify(await respA.json());
      const bodyB = JSON.stringify(await respB.json());
      expect(bodyA).toContain("ALPHA");
      expect(bodyB).toContain("BETA");
      expect(bodyA).not.toContain("BETA");
      expect(bodyB).not.toContain("ALPHA");

      // Serial execution would be ~2 * SLEEP_MS; parallel should complete
      // close to one SLEEP_MS. Allow generous slack for process startup
      // and JSON-RPC round-trips while still failing clearly under a
      // serial-under-a-shared-gate regression.
      expect(elapsed).toBeLessThan(SLEEP_MS * 1.8);
    } finally {
      await parallelHandle.stop();
    }
  }, 15000);

  test("concurrent different contextIds receive distinct responses", async () => {
    // Regression guard for the per-contextId lane refactor
    // that replaced the executor-wide `inFlightPrompt` single-slot mutex.
    // Previously, two independent contextIds hitting the executor concurrently
    // could collapse onto one owner's PromptOutcome, and the joiner's response
    // stream would carry the owner's text. Each contextId now gets its own
    // `inFlightPrompt` slot; distinct contextIds now
    // resolve independently and receive their own echoed payloads back.
    const ctxA = `ctx-A-${crypto.randomUUID()}`;
    const ctxB = `ctx-B-${crypto.randomUUID()}`;

    // `__ECHO__:<tag>` is a mock-agent directive (see tests/mock-acp-agent.cjs)
    // that replies with `__ECHO__:<tag>` as the agent message. It lets this
    // test assert each lane's response without cross-talk.
    const [respA, respB] = await Promise.all([
      sendMessage("__ECHO__:ALPHA-payload", ctxA),
      sendMessage("__ECHO__:BETA-payload", ctxB),
    ]);

    expect(respA.ok).toBe(true);
    expect(respB.ok).toBe(true);

    const bodyA = JSON.stringify(await respA.json());
    const bodyB = JSON.stringify(await respB.json());

    // Critical: each contextId got ITS OWN echoed payload back, no
    // cross-talk from the joiner-republish path.
    expect(bodyA).toContain("ALPHA-payload");
    expect(bodyA).not.toContain("BETA-payload");
    expect(bodyB).toContain("BETA-payload");
    expect(bodyB).not.toContain("ALPHA-payload");
  }, 10000);
});
