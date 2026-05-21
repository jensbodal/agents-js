/**
 * Wire-up tests for the Gitea bridge mount (AJS-59 v1 PR 3/3).
 *
 * Behavior pinned here:
 *
 * 1. **Opt-out is the default.** When `GITEA_WEBHOOK_SECRET` is unset,
 *    `setupGiteaBridge` returns `null` — the gateway must boot exactly
 *    as it did before this PR. Any silent default-on behavior is a
 *    deployment hazard (an unsigned webhook surface listening on a
 *    trusted-network port).
 *
 * 2. **Required-when-enabled vars throw fast.** If the secret is set
 *    but `GITEA_BRIDGE_SEND_SCRIPT` is missing, the gateway must crash
 *    at startup with a clear message — not boot into a half-wired
 *    state where webhooks publish to the bus but never reach Matrix.
 *
 * 3. **End-to-end wiring works.** When env is complete, an incoming
 *    HMAC-signed POST to `/webhooks/gitea` publishes a bus event, the
 *    consumer formats a Matrix body, and the injected `send` callback
 *    receives it with the configured identity + room.
 *
 * 4. **Env contract.** `GITEA_BRIDGE_ALLOWED_REPOS` is CSV-parsed;
 *    `GITEA_BRIDGE_IDENTITY` defaults to `"gitea-bot"`; `GITEA_BRIDGE_ROOM`
 *    is optional.
 */

import { describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { createGatewayBus } from "@agents-js/host";
import { readGiteaBridgeEnv, setupGiteaBridge } from "../gitea-bridge-mount.ts";

const SECRET = "test-secret-9e7c";

/**
 * Sign the body the same way Gitea does: HMAC-SHA256, hex-encoded,
 * sent in `X-Gitea-Signature`. Matches `verifyHmac` in
 * `extras/gitea-bridge/src/receiver.ts`.
 */
function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

/** Minimal valid pull_request payload that satisfies `extractRepo`. */
function pullRequestPayload(): string {
  return JSON.stringify({
    action: "opened",
    pull_request: {
      number: 47,
      title: "AJS-59 v1 PR 3/3",
      html_url: "https://gitea.q4m.dev/jensbodal/agents-js/pulls/47",
      head: { sha: "deadbeef" },
    },
    repository: { full_name: "jensbodal/agents-js" },
    sender: { login: "jensbodal" },
  });
}

describe("apps/internal-gateway/gitea-bridge-mount.ts", () => {
  /**
   * WHAT: `readGiteaBridgeEnv` returns `null` when `GITEA_WEBHOOK_SECRET`
   *       is absent.
   * WHY: This is the dev-mode default. The gateway must not stand up a
   *      webhook surface implicitly — a half-configured production
   *      install (secret set in vault, app deployed without env wired)
   *      would surface a default-allow webhook receiver; making the
   *      enable gate explicit prevents that.
   */
  test("readGiteaBridgeEnv returns null when GITEA_WEBHOOK_SECRET is unset", () => {
    expect(readGiteaBridgeEnv({})).toBeNull();
    expect(readGiteaBridgeEnv({ GITEA_BRIDGE_SEND_SCRIPT: "/x" })).toBeNull();
  });

  /**
   * WHAT: When secret is set but `GITEA_BRIDGE_SEND_SCRIPT` is missing,
   *       `readGiteaBridgeEnv` throws an error mentioning both vars.
   * WHY: A receiver mounted with no consumer would silently swallow
   *      Gitea events (they'd publish to the bus but no Matrix output).
   *      Failing fast at startup forces the operator to complete the
   *      configuration.
   */
  test("readGiteaBridgeEnv throws when secret set without send-script", () => {
    expect(() => readGiteaBridgeEnv({ GITEA_WEBHOOK_SECRET: SECRET })).toThrow(
      /GITEA_BRIDGE_SEND_SCRIPT/,
    );
  });

  /**
   * WHAT: With all required vars set, `readGiteaBridgeEnv` returns a
   *       config whose fields match the env exactly.
   * WHY: Pins the env-var name contract — deployment automation writes
   *      these names into the gateway's env file. A future rename here
   *      without a coordinated role change would break the deployed
   *      bridge silently (gateway boots, env unread, feature no-op).
   */
  test("readGiteaBridgeEnv parses full env into a typed config", () => {
    const config = readGiteaBridgeEnv({
      GITEA_WEBHOOK_SECRET: SECRET,
      GITEA_BRIDGE_SEND_SCRIPT: "/usr/local/lib/agents-js-gateway/matrix-send-gateway.ts",
      GITEA_BRIDGE_ROOM: "!cJxcDspkqBHcoALJCy:matrix.example",
      GITEA_BRIDGE_ALLOWED_REPOS: "jensbodal/agents-js,jensbodal/dot-cognee",
      GITEA_BRIDGE_IDENTITY: "custom-bot",
    });
    expect(config).not.toBeNull();
    if (config === null) throw new Error("unreachable");
    expect(config.secret).toBe(SECRET);
    expect(config.sendScript).toBe("/usr/local/lib/agents-js-gateway/matrix-send-gateway.ts");
    expect(config.room).toBe("!cJxcDspkqBHcoALJCy:matrix.example");
    expect(config.allowedRepos).toEqual(["jensbodal/agents-js", "jensbodal/dot-cognee"]);
    expect(config.identity).toBe("custom-bot");
  });

  /**
   * WHAT: Missing optional vars resolve to sensible defaults — empty
   *       `allowedRepos`, `room: undefined`, `identity: "gitea-bot"`.
   * WHY: A minimum-config production install may set only the required
   *      pair (secret + send-script) and defer the optional vars.
   *      Defaults must keep the bridge functional in that state.
   */
  test("readGiteaBridgeEnv defaults optional vars cleanly", () => {
    const config = readGiteaBridgeEnv({
      GITEA_WEBHOOK_SECRET: SECRET,
      GITEA_BRIDGE_SEND_SCRIPT: "/x/y/send.ts",
    });
    expect(config).not.toBeNull();
    if (config === null) throw new Error("unreachable");
    expect(config.room).toBeUndefined();
    expect(config.allowedRepos).toEqual([]);
    expect(config.identity).toBe("gitea-bot");
  });

  /**
   * WHAT: `GITEA_BRIDGE_ALLOWED_REPOS` is CSV-parsed with whitespace
   *       trimmed and empty entries dropped.
   * WHY: The env-file format is operator-edited; trailing commas and
   *      stray spaces are the rule, not the exception. Failing to
   *      handle them would either crash startup or leak empty-string
   *      entries into the allowlist (which would never match any repo
   *      and silently drop everything).
   */
  test("readGiteaBridgeEnv tolerates whitespace and trailing commas in repo CSV", () => {
    const config = readGiteaBridgeEnv({
      GITEA_WEBHOOK_SECRET: SECRET,
      GITEA_BRIDGE_SEND_SCRIPT: "/x",
      GITEA_BRIDGE_ALLOWED_REPOS: " jensbodal/agents-js , , jensbodal/dot-cognee,",
    });
    if (config === null) throw new Error("unreachable");
    expect(config.allowedRepos).toEqual(["jensbodal/agents-js", "jensbodal/dot-cognee"]);
  });

  /**
   * WHAT: `setupGiteaBridge` returns `null` when env is unset.
   * WHY: Pins the integration contract — the gateway treats this as
   *      "feature disabled, skip mount entirely." Any change that
   *      makes `setupGiteaBridge` return a non-null value implicitly
   *      would change the deployed surface in dev environments.
   */
  test("setupGiteaBridge returns null when env disables the bridge", () => {
    const bus = createGatewayBus();
    expect(setupGiteaBridge({ bus, overrides: { env: {} } })).toBeNull();
  });

  /**
   * WHAT: End-to-end — POST to the returned handler with a valid
   *       HMAC-signed body causes the injected `send` callback to be
   *       invoked with a formatted Matrix body, configured identity,
   *       and configured room.
   * WHY: This is the end-to-end smoke that pins the AJS-59 contract.
   *      The wiring must compose: receiver → bus → consumer → send.
   *      A drop anywhere breaks the user-visible promise that "a Gitea
   *      PR appears as a Matrix message."
   */
  test("setupGiteaBridge wires receiver → consumer → send end-to-end", async () => {
    const bus = createGatewayBus();
    const sent: Array<{ body: string; identity: string; room?: string }> = [];
    const wireup = setupGiteaBridge({
      bus,
      overrides: {
        config: {
          secret: SECRET,
          sendScript: "/unused-by-test",
          room: "!testroom:matrix.example",
          allowedRepos: [],
          identity: "gitea-bot",
        },
        send: async (args) => {
          sent.push({
            body: args.body,
            identity: args.identity,
            ...(args.room !== undefined ? { room: args.room } : {}),
          });
        },
      },
    });
    expect(wireup).not.toBeNull();
    if (wireup === null) throw new Error("unreachable");

    const body = pullRequestPayload();
    const res = await wireup.fetchHandler(
      new Request("http://gw.local/webhooks/gitea", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitea-Signature": sign(body),
          "X-Gitea-Event": "pull_request",
          "X-Gitea-Delivery": randomUUID(),
        },
        body,
      }),
    );
    expect(res?.status).toBe(200);

    // Consumer is async — give the bus event a tick to propagate.
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.identity).toBe("gitea-bot");
    expect(sent[0]?.room).toBe("!testroom:matrix.example");
    expect(sent[0]?.body).toContain("[gitea/jensbodal/agents-js]");
    expect(sent[0]?.body).toContain("PR opened by jensbodal");
    expect(sent[0]?.body).toContain("AJS-59 v1 PR 3/3");

    wireup.consumer.stop();
  });

  /**
   * WHAT: Non-matching paths fall through (`fetchHandler` returns
   *       `null`), so the gateway's other handlers (AG-UI, registry
   *       sync) are unaffected.
   * WHY: The receiver is mounted in `composeAdditionalFetch`'s chain;
   *      returning a non-null `Response` for unrelated paths would
   *      shadow AG-UI's `/agent` route. Pinning the "null on
   *      no-match" contract here catches a class of routing bugs that
   *      the full-server tests would surface much later.
   */
  test("setupGiteaBridge handler returns null for non-matching paths", async () => {
    const bus = createGatewayBus();
    const wireup = setupGiteaBridge({
      bus,
      overrides: {
        config: {
          secret: SECRET,
          sendScript: "/unused",
          allowedRepos: [],
          identity: "gitea-bot",
        },
        send: async () => {},
      },
    });
    if (wireup === null) throw new Error("unreachable");

    const res = await wireup.fetchHandler(new Request("http://gw.local/agent", { method: "POST" }));
    expect(res).toBeNull();

    wireup.consumer.stop();
  });
});
