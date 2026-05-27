import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AutoRegisterOptions,
  readAgentRegistryRecords,
  startAutoRegisterHeartbeat,
} from "../src/node.ts";

let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "heartbeat-test-"));
  configPath = join(tmpDir, "registry.json");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Deterministic scheduler: records every scheduled callback and lets
 * tests advance them in order. No real timers — every assertion is
 * driven by `flush(n)` which runs the next `n` scheduled callbacks.
 *
 * Each tick can synchronously schedule a follow-up tick (the heartbeat
 * loop does this). `flush` runs callbacks already queued at entry, then
 * yields a microtask so async work inside the callback (registerFn
 * await) can resolve before the next `flush` runs the rescheduled tick.
 */
interface ScheduledCall {
  cb: () => void;
  delayMs: number;
  cancelled: boolean;
}

function makeScheduler() {
  const queue: ScheduledCall[] = [];
  const scheduler = {
    setTimeout(cb: () => void, ms: number): ScheduledCall {
      const entry: ScheduledCall = { cb, delayMs: ms, cancelled: false };
      queue.push(entry);
      return entry;
    },
    clearTimeout(handle: unknown): void {
      if (handle && typeof handle === "object" && "cancelled" in handle) {
        (handle as ScheduledCall).cancelled = true;
      }
    },
  };
  const drainMicrotasks = async (): Promise<void> => {
    // Three rounds is enough for the tick body's `await resolveUrl` +
    // `await registerFn` + the synchronous `schedule()` that follows.
    for (let r = 0; r < 4; r += 1) {
      await Promise.resolve();
    }
  };
  const flush = async (count = 1): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      const next = queue.shift();
      if (!next) return;
      if (next.cancelled) {
        i -= 1;
        continue;
      }
      next.cb();
      await drainMicrotasks();
    }
  };
  return { scheduler, queue, flush, drainMicrotasks };
}

describe("startAutoRegisterHeartbeat", () => {
  test("registers immediately on first tick and re-registers at the configured interval", async () => {
    const { scheduler, queue, flush, drainMicrotasks } = makeScheduler();
    const registerFn = mock(async (_opts: AutoRegisterOptions) => undefined);

    const handle = startAutoRegisterHeartbeat({
      name: "gw",
      url: "http://gw.test:9000",
      configPath,
      intervalMs: 60_000,
      scheduler,
      registerFn,
    });

    // Initial registration fires synchronously; let its awaited
    // registerFn resolve before inspecting the scheduled follow-up.
    await drainMicrotasks();
    expect(registerFn).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.delayMs).toBe(60_000);

    await flush(1); // second tick
    expect(registerFn).toHaveBeenCalledTimes(2);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.delayMs).toBe(60_000);

    handle.stop();
  });

  test("retries with exponential backoff on registerFn failure", async () => {
    const { scheduler, queue, flush, drainMicrotasks } = makeScheduler();
    const errors = ["boom-1", "boom-2", "boom-3"];
    let callIndex = 0;
    const registerFn = mock(async (_opts: AutoRegisterOptions) => {
      const err = errors[callIndex];
      callIndex += 1;
      if (err) throw new Error(err);
      return undefined;
    });
    const logger = { log: mock(), warn: mock(), error: mock() };

    const handle = startAutoRegisterHeartbeat({
      name: "gw",
      url: "http://gw.test:9000",
      configPath,
      intervalMs: 60_000,
      initialBackoffMs: 5_000,
      maxBackoffMs: 60_000,
      scheduler,
      registerFn,
      logger,
    });

    // Synchronous initial tick — fails.
    await drainMicrotasks();
    expect(registerFn).toHaveBeenCalledTimes(1);
    expect(queue[0]?.delayMs).toBe(5_000); // initial backoff

    await flush(1); // retry 1 — fails
    expect(registerFn).toHaveBeenCalledTimes(2);
    expect(queue[0]?.delayMs).toBe(10_000); // doubled

    await flush(1); // retry 2 — fails
    expect(registerFn).toHaveBeenCalledTimes(3);
    expect(queue[0]?.delayMs).toBe(20_000); // doubled again

    await flush(1); // retry 3 — succeeds
    expect(registerFn).toHaveBeenCalledTimes(4);
    expect(queue[0]?.delayMs).toBe(60_000); // back to interval after success

    expect(logger.warn).toHaveBeenCalledTimes(3);
    handle.stop();
  });

  test("backoff caps at maxBackoffMs", async () => {
    const { scheduler, queue, flush, drainMicrotasks } = makeScheduler();
    const registerFn = mock(async (_opts: AutoRegisterOptions) => {
      throw new Error("always-fails");
    });

    const handle = startAutoRegisterHeartbeat({
      name: "gw",
      url: "http://gw.test:9000",
      configPath,
      intervalMs: 60_000,
      initialBackoffMs: 5_000,
      maxBackoffMs: 30_000,
      scheduler,
      registerFn,
      logger: { log: mock(), warn: mock(), error: mock() },
    });

    // Synchronous initial tick — fails.
    await drainMicrotasks();
    expect(queue[0]?.delayMs).toBe(5_000); // 5
    await flush(1);
    expect(queue[0]?.delayMs).toBe(10_000); // 10
    await flush(1);
    expect(queue[0]?.delayMs).toBe(20_000); // 20
    await flush(1);
    expect(queue[0]?.delayMs).toBe(30_000); // capped at 30
    await flush(1);
    expect(queue[0]?.delayMs).toBe(30_000); // stays at cap

    handle.stop();
  });

  test("stop() cancels future ticks", async () => {
    const { scheduler, flush, drainMicrotasks } = makeScheduler();
    const registerFn = mock(async (_opts: AutoRegisterOptions) => undefined);

    const handle = startAutoRegisterHeartbeat({
      name: "gw",
      url: "http://gw.test:9000",
      configPath,
      intervalMs: 60_000,
      scheduler,
      registerFn,
    });

    // Synchronous initial tick.
    await drainMicrotasks();
    expect(registerFn).toHaveBeenCalledTimes(1);
    handle.stop();

    // The post-success follow-up tick was scheduled, but stop() cancelled it.
    // Flushing should be a no-op.
    await flush(5);
    expect(registerFn).toHaveBeenCalledTimes(1);

    // stop() is idempotent.
    expect(() => handle.stop()).not.toThrow();
  });

  test("intervalMs: 0 disables periodic loop but initial registration still runs", async () => {
    const { scheduler, queue, drainMicrotasks } = makeScheduler();
    const registerFn = mock(async (_opts: AutoRegisterOptions) => undefined);

    const handle = startAutoRegisterHeartbeat({
      name: "gw",
      url: "http://gw.test:9000",
      configPath,
      intervalMs: 0,
      scheduler,
      registerFn,
    });

    await drainMicrotasks();
    expect(registerFn).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(0); // no follow-up scheduled

    handle.stop();
  });

  test("intervalMs: 0 + failing registerFn: NO retry scheduled (honors docstring contract)", async () => {
    // Regression guard for the #156 nitpick: the success path correctly
    // gated `schedule(intervalMs)` on `intervalMs > 0`, but the failure
    // path unconditionally called `schedule(retryDelay)`. Operators who
    // explicitly set intervalMs<=0 expect "fire once, don't keep running"
    // — silently retrying on first-attempt failure would violate that.
    const { scheduler, queue, drainMicrotasks } = makeScheduler();
    const registerFn = mock(async (_opts: AutoRegisterOptions) => {
      throw new Error("transient network blip");
    });

    const handle = startAutoRegisterHeartbeat({
      name: "gw",
      url: "http://gw.test:9000",
      configPath,
      intervalMs: 0,
      scheduler,
      registerFn,
    });

    await drainMicrotasks();
    expect(registerFn).toHaveBeenCalledTimes(1); // initial attempt fired
    expect(queue).toHaveLength(0); // NO retry scheduled despite the failure

    handle.stop();
  });

  test("intervalMs: -1 (negative): same one-shot semantics as 0 + failing registerFn does not retry", async () => {
    const { scheduler, queue, drainMicrotasks } = makeScheduler();
    const registerFn = mock(async (_opts: AutoRegisterOptions) => {
      throw new Error("boom");
    });

    const handle = startAutoRegisterHeartbeat({
      name: "gw",
      url: "http://gw.test:9000",
      configPath,
      intervalMs: -1,
      scheduler,
      registerFn,
    });

    await drainMicrotasks();
    expect(registerFn).toHaveBeenCalledTimes(1);
    expect(queue).toHaveLength(0);

    handle.stop();
  });

  test("urlProvider is invoked on every tick", async () => {
    const { scheduler, flush, drainMicrotasks } = makeScheduler();
    const urls = ["http://gw.test:1", "http://gw.test:2", "http://gw.test:3"];
    let urlIdx = 0;
    const provider = mock(() => {
      const u = urls[urlIdx % urls.length];
      urlIdx += 1;
      return u as string;
    });
    const seenUrls: string[] = [];
    const registerFn = mock(async (opts: AutoRegisterOptions) => {
      if (opts.kind === "a2a") seenUrls.push(opts.url);
      return undefined;
    });

    const handle = startAutoRegisterHeartbeat({
      name: "gw",
      url: provider,
      configPath,
      intervalMs: 60_000,
      scheduler,
      registerFn,
    });

    // Initial synchronous tick + two flushed follow-ups.
    await drainMicrotasks();
    await flush(2);
    expect(seenUrls).toEqual(urls);
    handle.stop();
  });

  test("integrates with real autoRegister and writes a record on first tick", async () => {
    // Use a short real interval so the test runs the full path (no
    // registerFn override) without leaning on global fake-timer support.
    const { scheduler } = makeScheduler();
    const handle = startAutoRegisterHeartbeat({
      name: "real-gw",
      url: "http://real.test:7777",
      configPath,
      intervalMs: 60_000,
      scheduler,
    });

    // Initial tick runs synchronously; let its disk I/O settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const records = await readAgentRegistryRecords({ configPath });
    expect(records).toHaveLength(1);
    const rec = records[0];
    if (!rec) throw new Error("record missing");
    expect(rec.name).toBe("real-gw");
    expect(rec.url).toBe("http://real.test:7777");
    expect(rec.source).toBe("auto-reg");
    handle.stop();
  });
});
