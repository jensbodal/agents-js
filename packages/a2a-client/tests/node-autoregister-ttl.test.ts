import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRegistryRecordExpired,
  type RegistryReadLogger,
  readAgentRegistryRecords,
} from "../src/node.ts";

let tmpDir: string;
let configPath: string;

const FROZEN_NOW = new Date("2026-05-27T12:00:00.000Z");
const PAST = new Date("2026-05-27T11:00:00.000Z").toISOString();
const FUTURE = new Date("2026-05-27T13:00:00.000Z").toISOString();

const FIXTURE = {
  version: 2 as const,
  agents: {
    fresh: {
      name: "fresh",
      agent_id: "host.fresh",
      kind: "a2a",
      url: "http://fresh.test",
      gateway_id: "host",
      source: "auto-reg",
      registered_at: "2026-05-27T11:30:00.000Z",
      expires_at: FUTURE,
    },
    expired: {
      name: "expired",
      agent_id: "host.expired",
      kind: "a2a",
      url: "http://expired.test",
      gateway_id: "host",
      source: "auto-reg",
      registered_at: "2026-05-27T10:00:00.000Z",
      expires_at: PAST,
    },
    "never-expires": {
      name: "never-expires",
      agent_id: "host.never-expires",
      kind: "a2a",
      url: "http://never.test",
      gateway_id: "host",
      source: "manual",
      registered_at: "2026-05-27T08:00:00.000Z",
      // No expires_at — v1-style record, never considered expired.
    },
  },
};

function makeLogger(): {
  logger: RegistryReadLogger;
  warnings: string[];
} {
  const warnings: string[] = [];
  return {
    logger: { warn: (msg: unknown) => warnings.push(String(msg)) },
    warnings,
  };
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ajs-97-ttl-"));
  configPath = join(tmpDir, "registry.json");
  await writeFile(configPath, `${JSON.stringify(FIXTURE, null, 2)}\n`);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("readAgentRegistryRecords — expiryPolicy (AJS-97)", () => {
  test("filter-expired returns non-expired records; file is untouched", async () => {
    const before = await readFile(configPath, "utf-8");

    const records = await readAgentRegistryRecords({
      configPath,
      expiryPolicy: { mode: "filter-expired", now: () => FROZEN_NOW },
    });

    const names = records.map((r) => r.name).sort();
    expect(names).toEqual(["fresh", "never-expires"]);

    const after = await readFile(configPath, "utf-8");
    expect(after).toBe(before);
  });

  test("include-expired returns every record verbatim", async () => {
    const records = await readAgentRegistryRecords({
      configPath,
      expiryPolicy: { mode: "include-expired", now: () => FROZEN_NOW },
    });

    const names = records.map((r) => r.name).sort();
    expect(names).toEqual(["expired", "fresh", "never-expires"]);
  });

  test("filter-and-drop removes expired rows from disk; returns non-expired", async () => {
    const records = await readAgentRegistryRecords({
      configPath,
      expiryPolicy: { mode: "filter-and-drop", now: () => FROZEN_NOW },
    });

    const names = records.map((r) => r.name).sort();
    expect(names).toEqual(["fresh", "never-expires"]);

    const onDiskRaw = await readFile(configPath, "utf-8");
    const onDisk = JSON.parse(onDiskRaw) as {
      agents: Record<string, unknown>;
    };
    expect(Object.keys(onDisk.agents).sort()).toEqual(["fresh", "never-expires"]);
    expect(onDisk.agents.expired).toBeUndefined();
  });

  test("default mode (no expiryPolicy option) behaves like filter-expired", async () => {
    // Set up a fixture with an expired row using a past expiry so the
    // wall-clock comparison still classifies it as expired without needing
    // a `now` factory (validates the option-less default path).
    const longPast = new Date("2000-01-01T00:00:00.000Z").toISOString();
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 2,
          agents: {
            keep: {
              name: "keep",
              agent_id: "host.keep",
              kind: "a2a",
              url: "http://keep.test",
              gateway_id: "host",
              source: "manual",
              registered_at: longPast,
              // No expires_at — never expires.
            },
            "way-past": {
              name: "way-past",
              agent_id: "host.way-past",
              kind: "a2a",
              url: "http://way-past.test",
              gateway_id: "host",
              source: "auto-reg",
              registered_at: longPast,
              expires_at: longPast,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const records = await readAgentRegistryRecords({ configPath });

    const names = records.map((r) => r.name).sort();
    expect(names).toEqual(["keep"]);
  });

  test("malformed expires_at is treated as never-expires and logged", async () => {
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 2,
          agents: {
            broken: {
              name: "broken",
              agent_id: "host.broken",
              kind: "a2a",
              url: "http://broken.test",
              gateway_id: "host",
              source: "auto-reg",
              registered_at: "2026-05-27T11:00:00.000Z",
              expires_at: "not-a-date",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const { logger, warnings } = makeLogger();
    const records = await readAgentRegistryRecords({
      configPath,
      expiryPolicy: { mode: "filter-expired", now: () => FROZEN_NOW, logger },
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("broken");
    expect(warnings.some((w) => w.includes("Malformed expires_at"))).toBe(true);
  });

  test("now exactly equal to expires_at is expired (boundary is <=)", async () => {
    const exact = "2026-05-27T12:00:00.000Z";
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 2,
          agents: {
            boundary: {
              name: "boundary",
              agent_id: "host.boundary",
              kind: "a2a",
              url: "http://boundary.test",
              gateway_id: "host",
              source: "auto-reg",
              registered_at: "2026-05-27T11:00:00.000Z",
              expires_at: exact,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const records = await readAgentRegistryRecords({
      configPath,
      expiryPolicy: { mode: "filter-expired", now: () => new Date(exact) },
    });

    expect(records).toHaveLength(0);
  });

  test("filter-and-drop is atomic vs a concurrent write that lands mid-pass", async () => {
    // Strategy: inject a hook that runs between the initial read and the
    // GC re-read. The hook writes a competing record to the same file.
    // The drop pass must merge the competing record into the rewrite,
    // not clobber it.
    const competing = {
      name: "competing",
      agent_id: "host.competing",
      kind: "a2a",
      url: "http://competing.test",
      gateway_id: "host",
      source: "auto-reg",
      registered_at: "2026-05-27T11:59:00.000Z",
      // No expires_at — must survive every filter.
    };

    const records = await readAgentRegistryRecords({
      configPath,
      expiryPolicy: {
        mode: "filter-and-drop",
        now: () => FROZEN_NOW,
        __beforeDropRereadHook: async () => {
          // Read current file, splice in the competing record, write back.
          // This simulates an autoRegister call landing between our read
          // and our drop-rewrite.
          const current = JSON.parse(await readFile(configPath, "utf-8")) as {
            version: 2;
            agents: Record<string, unknown>;
          };
          current.agents.competing = competing;
          await writeFile(configPath, `${JSON.stringify(current, null, 2)}\n`);
        },
      },
    });

    // Returned list reflects the FIRST read — competing isn't in it,
    // but it MUST be preserved on disk.
    expect(records.map((r) => r.name).sort()).toEqual(["fresh", "never-expires"]);

    const onDisk = JSON.parse(await readFile(configPath, "utf-8")) as {
      agents: Record<string, unknown>;
    };
    expect(Object.keys(onDisk.agents).sort()).toEqual(["competing", "fresh", "never-expires"]);
    expect(onDisk.agents.expired).toBeUndefined();
    expect(onDisk.agents.competing).toBeDefined();
  });

  test("filter-and-drop with no expired rows leaves the file untouched", async () => {
    // No-expired fixture: only fresh + never-expires rows. The drop
    // pass should short-circuit before any file rewrite.
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 2,
          agents: {
            a: {
              name: "a",
              agent_id: "host.a",
              kind: "a2a",
              url: "http://a.test",
              gateway_id: "host",
              source: "auto-reg",
              registered_at: "2026-05-27T11:00:00.000Z",
              expires_at: FUTURE,
            },
            b: {
              name: "b",
              agent_id: "host.b",
              kind: "a2a",
              url: "http://b.test",
              gateway_id: "host",
              source: "manual",
              registered_at: "2026-05-27T08:00:00.000Z",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const before = await readFile(configPath, "utf-8");

    const records = await readAgentRegistryRecords({
      configPath,
      expiryPolicy: { mode: "filter-and-drop", now: () => FROZEN_NOW },
    });

    expect(records.map((r) => r.name).sort()).toEqual(["a", "b"]);
    const after = await readFile(configPath, "utf-8");
    expect(after).toBe(before);
  });
});

describe("isRegistryRecordExpired", () => {
  test("record with no expires_at is never expired", () => {
    expect(isRegistryRecordExpired({ name: "x" }, FROZEN_NOW)).toBe(false);
  });

  test("record with future expires_at is not expired", () => {
    expect(isRegistryRecordExpired({ name: "x", expires_at: FUTURE }, FROZEN_NOW)).toBe(false);
  });

  test("record with past expires_at is expired", () => {
    expect(isRegistryRecordExpired({ name: "x", expires_at: PAST }, FROZEN_NOW)).toBe(true);
  });

  test("record at boundary (now == expires_at) is expired", () => {
    const exact = "2026-05-27T12:00:00.000Z";
    expect(isRegistryRecordExpired({ name: "x", expires_at: exact }, new Date(exact))).toBe(true);
  });

  test("malformed expires_at is treated as never-expires and logged", () => {
    const { logger, warnings } = makeLogger();
    expect(
      isRegistryRecordExpired({ name: "broken", expires_at: "not-a-date" }, FROZEN_NOW, logger),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Malformed expires_at");
    expect(warnings[0]).toContain("broken");
  });
});
