/**
 * Tests for `@agents-js/wake-signal-store` scaffold.
 *
 * Coverage:
 *  - InMemoryWakeSignalStoreBackend primitives (put/get/update/delete/list).
 *  - WakeSignalStore TTL filtering (expired records invisible to readers).
 *  - At-least-once dedup via markDelivered.
 *  - GC removes expired records.
 *  - Target equality across both target kinds.
 */

import { describe, expect, test } from "bun:test";

import type {
  InSessionPushWakeAdapter,
  WakeIdempotencyKey,
  WakeSignalId,
  WakeTarget,
} from "@agents-js/wake-types";

import {
  createWakeSignalStore,
  InMemoryWakeSignalStoreBackend,
  type WakeSignalRecord,
} from "../src/index.ts";

const SIGNAL_ID_A = "signal-a" as WakeSignalId;
const SIGNAL_ID_B = "signal-b" as WakeSignalId;
const IDEM_KEY_A = "idem-a" as WakeIdempotencyKey;
const IDEM_KEY_B = "idem-b" as WakeIdempotencyKey;

const TARGET_SESSION_X: WakeTarget = {
  kind: "session",
  sessionId: "session-x",
};
const TARGET_SESSION_Y: WakeTarget = {
  kind: "session",
  sessionId: "session-y",
};
const TARGET_AGENT_X: WakeTarget = { kind: "agent", agentName: "agent-x" };

const SAMPLE_ADAPTER: InSessionPushWakeAdapter = {
  shape: "in-session-push",
  signalId: SIGNAL_ID_A,
  target: TARGET_SESSION_X,
  expiresAtMs: 10_000,
  idempotencyKey: IDEM_KEY_A,
  payload: { method: "test", params: {} },
};

function makeRecord(
  overrides: Partial<WakeSignalRecord> & {
    signalId: WakeSignalId;
    idempotencyKey: WakeIdempotencyKey;
    target: WakeTarget;
  },
): WakeSignalRecord {
  return {
    signalId: overrides.signalId,
    idempotencyKey: overrides.idempotencyKey,
    target: overrides.target,
    adapter: overrides.adapter ?? SAMPLE_ADAPTER,
    createdAtMs: overrides.createdAtMs ?? 1_000,
    expiresAtMs: overrides.expiresAtMs ?? 10_000,
    deliveredAtMs: overrides.deliveredAtMs,
  };
}

describe("InMemoryWakeSignalStoreBackend", () => {
  test("put + get round-trips a record", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const record = makeRecord({
      signalId: SIGNAL_ID_A,
      idempotencyKey: IDEM_KEY_A,
      target: TARGET_SESSION_X,
    });
    await backend.put(record);
    const fetched = await backend.get(SIGNAL_ID_A);
    expect(fetched).toEqual(record);
  });

  test("put rejects duplicate signalId", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const record = makeRecord({
      signalId: SIGNAL_ID_A,
      idempotencyKey: IDEM_KEY_A,
      target: TARGET_SESSION_X,
    });
    await backend.put(record);
    await expect(backend.put(record)).rejects.toThrow(/already present/);
  });

  test("update requires existing signalId", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const record = makeRecord({
      signalId: SIGNAL_ID_A,
      idempotencyKey: IDEM_KEY_A,
      target: TARGET_SESSION_X,
    });
    await expect(backend.update(record)).rejects.toThrow(/not present/);
  });

  test("delete is idempotent on absent records", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    await backend.delete(SIGNAL_ID_A); // does not throw
    expect(await backend.get(SIGNAL_ID_A)).toBeUndefined();
  });

  test("listByTarget filters by session target", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    await backend.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
        createdAtMs: 1_000,
      }),
    );
    await backend.put(
      makeRecord({
        signalId: SIGNAL_ID_B,
        idempotencyKey: IDEM_KEY_B,
        target: TARGET_SESSION_Y,
        createdAtMs: 2_000,
      }),
    );
    const xs = await backend.listByTarget(TARGET_SESSION_X);
    expect(xs.map((r) => r.signalId)).toEqual([SIGNAL_ID_A]);
  });

  test("listByTarget sorts by createdAtMs ascending", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    await backend.put(
      makeRecord({
        signalId: SIGNAL_ID_B,
        idempotencyKey: IDEM_KEY_B,
        target: TARGET_SESSION_X,
        createdAtMs: 2_000,
      }),
    );
    await backend.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
        createdAtMs: 1_000,
      }),
    );
    const xs = await backend.listByTarget(TARGET_SESSION_X);
    expect(xs.map((r) => r.signalId)).toEqual([SIGNAL_ID_A, SIGNAL_ID_B]);
  });

  test("listByTarget distinguishes session and agent kinds", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    await backend.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
      }),
    );
    await backend.put(
      makeRecord({
        signalId: SIGNAL_ID_B,
        idempotencyKey: IDEM_KEY_B,
        target: TARGET_AGENT_X,
      }),
    );
    expect((await backend.listByTarget(TARGET_SESSION_X)).length).toBe(1);
    expect((await backend.listByTarget(TARGET_AGENT_X)).length).toBe(1);
  });

  test("listExpired returns records past now", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    await backend.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
        expiresAtMs: 5_000,
      }),
    );
    await backend.put(
      makeRecord({
        signalId: SIGNAL_ID_B,
        idempotencyKey: IDEM_KEY_B,
        target: TARGET_SESSION_X,
        expiresAtMs: 15_000,
      }),
    );
    const expired = await backend.listExpired(10_000);
    expect(expired.map((r) => r.signalId)).toEqual([SIGNAL_ID_A]);
  });
});

describe("WakeSignalStore (wrapper)", () => {
  test("get returns undefined for expired records", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const store = createWakeSignalStore({ backend, now: () => 20_000 });
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
        expiresAtMs: 10_000,
      }),
    );
    expect(await store.get(SIGNAL_ID_A)).toBeUndefined();
  });

  test("get returns the record when not expired", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const store = createWakeSignalStore({ backend, now: () => 5_000 });
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
        expiresAtMs: 10_000,
      }),
    );
    const fetched = await store.get(SIGNAL_ID_A);
    expect(fetched?.signalId).toBe(SIGNAL_ID_A);
  });

  test("pullPending excludes expired records", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const store = createWakeSignalStore({ backend, now: () => 20_000 });
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
        expiresAtMs: 10_000,
      }),
    );
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_B,
        idempotencyKey: IDEM_KEY_B,
        target: TARGET_SESSION_X,
        expiresAtMs: 30_000,
      }),
    );
    const pending = await store.pullPending(TARGET_SESSION_X);
    expect(pending.map((r) => r.signalId)).toEqual([SIGNAL_ID_B]);
  });

  test("pullPending excludes already-delivered records", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const store = createWakeSignalStore({ backend, now: () => 5_000 });
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
        expiresAtMs: 30_000,
      }),
    );
    await store.markDelivered(SIGNAL_ID_A, IDEM_KEY_A);
    const pending = await store.pullPending(TARGET_SESSION_X);
    expect(pending.length).toBe(0);
  });

  test("markDelivered returns true on first call, false on dedup", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const store = createWakeSignalStore({ backend, now: () => 5_000 });
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
      }),
    );
    expect(await store.markDelivered(SIGNAL_ID_A, IDEM_KEY_A)).toBe(true);
    expect(await store.markDelivered(SIGNAL_ID_A, IDEM_KEY_A)).toBe(false);
  });

  test("markDelivered rejects mismatched idempotency key", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const store = createWakeSignalStore({ backend, now: () => 5_000 });
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
      }),
    );
    await expect(store.markDelivered(SIGNAL_ID_A, IDEM_KEY_B)).rejects.toThrow(
      /idempotency key mismatch/,
    );
  });

  test("markDelivered rejects absent signalId", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const store = createWakeSignalStore({ backend, now: () => 5_000 });
    await expect(store.markDelivered(SIGNAL_ID_A, IDEM_KEY_A)).rejects.toThrow(
      /cannot mark delivered/,
    );
  });

  test("gcExpired removes expired records and returns count", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    const store = createWakeSignalStore({ backend, now: () => 20_000 });
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
        expiresAtMs: 10_000,
      }),
    );
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_B,
        idempotencyKey: IDEM_KEY_B,
        target: TARGET_SESSION_X,
        expiresAtMs: 30_000,
      }),
    );
    expect(await store.gcExpired()).toBe(1);
    expect(await backend.get(SIGNAL_ID_A)).toBeUndefined();
    expect(await backend.get(SIGNAL_ID_B)).toBeDefined();
  });

  test("clock injection lets tests drive time forward deterministically", async () => {
    const backend = new InMemoryWakeSignalStoreBackend();
    let nowMs = 0;
    const store = createWakeSignalStore({ backend, now: () => nowMs });
    await store.put(
      makeRecord({
        signalId: SIGNAL_ID_A,
        idempotencyKey: IDEM_KEY_A,
        target: TARGET_SESSION_X,
        expiresAtMs: 10_000,
      }),
    );
    nowMs = 5_000;
    expect(await store.get(SIGNAL_ID_A)).toBeDefined();
    nowMs = 15_000;
    expect(await store.get(SIGNAL_ID_A)).toBeUndefined();
  });
});
