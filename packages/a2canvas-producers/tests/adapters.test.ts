import { expect, test } from "bun:test";
import { createMatrixFetcher, createPlaneFetcher } from "../src/adapters.ts";

const okJson = (data: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(data), { status: 200 })) as unknown as typeof fetch;

test("matrix fetcher: maps m.room.message, drops non-messages, chronological order", async () => {
  const chunk = [
    // API returns newest-first (dir=b)
    {
      type: "m.room.message",
      event_id: "$b",
      sender: "@ajs-claude:hs",
      origin_server_ts: 2000,
      content: { body: "second", msgtype: "m.text" },
    },
    { type: "m.room.member", event_id: "$j", sender: "@x:hs", origin_server_ts: 1500, content: {} },
    {
      type: "m.room.message",
      event_id: "$a",
      sender: "@cognee-claude:hs",
      origin_server_ts: 1000,
      content: { body: "first" },
    },
  ];
  const fetcher = createMatrixFetcher({
    homeserverUrl: "https://hs",
    accessToken: "tok",
    roomId: "!room:hs",
    fetchImpl: okJson({ chunk }),
  });
  const out = await fetcher();
  expect(out.map((e) => e.event_id)).toEqual(["$a", "$b"]); // reversed → chronological
  expect(out[0]).toEqual({
    event_id: "$a",
    sender: "@cognee-claude:hs",
    timestamp: new Date(1000).toISOString(),
    body: "first",
  });
});

test("matrix fetcher: throws on non-ok status", async () => {
  const fetcher = createMatrixFetcher({
    homeserverUrl: "https://hs",
    accessToken: "tok",
    roomId: "!room:hs",
    fetchImpl: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch,
  });
  await expect(fetcher()).rejects.toThrow("403");
});

test("matrix fetcher: sends Bearer auth + correct messages URL", async () => {
  let seenUrl = "";
  let seenAuth = "";
  const fetcher = createMatrixFetcher({
    homeserverUrl: "https://hs",
    accessToken: "secret",
    roomId: "!r:hs",
    limit: 5,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
      return new Response(JSON.stringify({ chunk: [] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await fetcher();
  expect(seenUrl).toContain("/_matrix/client/v3/rooms/!r%3Ahs/messages");
  expect(seenUrl).toContain("limit=5");
  expect(seenAuth).toBe("Bearer secret");
});

test("plane fetcher: maps issues, resolves state name, builds url, multi-project", async () => {
  const fetcher = createPlaneFetcher({
    baseUrl: "https://plane.q4m.dev",
    apiKey: "pat",
    workspaceSlug: "dot",
    projects: [{ id: "p1", identifier: "DOT" }],
    stateNames: { s1: "In Progress" },
    actor: "plane",
    fetchImpl: okJson({
      results: [
        {
          id: "i1",
          sequence_id: 533,
          name: "demo",
          state: "s1",
          updated_at: "2026-06-15T15:00:00Z",
        },
        { id: "i2", sequence_id: 99, name: "skip-no-state", state: "", updated_at: "x" },
      ],
    }),
  });
  const out = await fetcher();
  expect(out.length).toBe(1); // the stateless issue is dropped
  expect(out[0]).toEqual({
    sequenceId: 533,
    projectIdentifier: "DOT",
    issueName: "demo",
    stateName: "In Progress",
    actor: "plane",
    actorKind: undefined,
    updatedAt: "2026-06-15T15:00:00Z",
    issueUrl: "https://plane.q4m.dev/dot/projects/p1/issues/i1",
  });
});

test("plane fetcher: unknown state id falls back to 'unknown'; throws on non-ok", async () => {
  const ok = createPlaneFetcher({
    baseUrl: "https://plane.q4m.dev",
    apiKey: "pat",
    workspaceSlug: "dot",
    projects: [{ id: "p1", identifier: "DOT" }],
    stateNames: {},
    fetchImpl: okJson({
      results: [{ id: "i1", sequence_id: 1, name: "x", state: "mystery", updated_at: "t" }],
    }),
  });
  expect((await ok())[0]?.stateName).toBe("unknown");

  const bad = createPlaneFetcher({
    baseUrl: "https://plane.q4m.dev",
    apiKey: "pat",
    workspaceSlug: "dot",
    projects: [{ id: "p1", identifier: "DOT" }],
    stateNames: {},
    fetchImpl: (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
  });
  await expect(bad()).rejects.toThrow("500");
});
