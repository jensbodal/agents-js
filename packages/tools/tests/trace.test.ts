import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyRedaction,
  createJsonlFileSink,
  createMemorySink,
  createNoopSink,
  REDACTION_SENTINEL,
  safeSerializeRecord,
  TOOL_CALL_TRACE_SCHEMA_VERSION,
  type ToolCallTrace,
  TraceEmitter,
  validateCompositionId,
  wrapToolWithTrace,
} from "../src/trace.ts";
import type { ToolDefinition } from "../src/types.ts";

describe("applyRedaction", () => {
  test("returns input unchanged when spec is absent or empty", () => {
    expect(applyRedaction({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(applyRedaction({ a: 1 }, [])).toEqual({ a: 1 });
  });

  test("replaces listed top-level keys with the sentinel", () => {
    const out = applyRedaction({ token: "secret", path: "/x" }, ["token"]) as Record<
      string,
      unknown
    >;
    expect(out.token).toBe(REDACTION_SENTINEL);
    expect(out.path).toBe("/x");
  });

  test("leaves scalar and array inputs unchanged (no way to key-redact)", () => {
    expect(applyRedaction("plain", ["token"])).toBe("plain");
    expect(applyRedaction([1, 2, 3], ["token"])).toEqual([1, 2, 3]);
    expect(applyRedaction(null, ["token"])).toBeNull();
  });

  test("does not mutate the input object", () => {
    const src = { token: "secret", path: "/x" };
    applyRedaction(src, ["token"]);
    expect(src.token).toBe("secret");
  });

  test("ignores keys that are not present", () => {
    const out = applyRedaction({ path: "/x" }, ["token"]) as Record<string, unknown>;
    expect(out).toEqual({ path: "/x" });
  });
});

describe("TraceEmitter.record", () => {
  test("emits an ok record with args and result on success", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({
      sink,
      agentId: "@test:example",
      now: fixedClock(),
      generateEventId: () => "event-1",
    });

    const result = await emitter.record(
      { toolName: "demo/echo", args: { msg: "hi" } },
      async () => "hello",
    );

    expect(result).toBe("hello");
    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    if (!record) throw new Error("expected one record");
    expect(record.schema_version).toBe(TOOL_CALL_TRACE_SCHEMA_VERSION);
    expect(record.event_id).toBe("event-1");
    expect(record.tool_name).toBe("demo/echo");
    expect(record.agent_id).toBe("@test:example");
    expect(record.session_id).toBeNull();
    expect(record.status).toBe("ok");
    expect(record.args).toEqual({ msg: "hi" });
    expect(record.result).toBe("hello");
    expect(record.parent_event_id).toBeNull();
    expect(record.root_event_id).toBe("event-1");
    expect(typeof record.timestamp).toBe("string");
    expect(record.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("rethrows and emits an error record when invoke throws", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({
      sink,
      agentId: "@test:example",
      generateEventId: () => "event-err",
    });

    const boom = new Error("nope");
    await expect(
      emitter.record({ toolName: "demo/fail" }, async () => {
        throw boom;
      }),
    ).rejects.toThrow("nope");

    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    if (!record) throw new Error("expected one record");
    expect(record.status).toBe("error");
    expect(record.error).toEqual({ code: "tools/invoke-failed", message: "nope" });
    expect(record.result).toBeUndefined();
  });

  test("applies args redaction before emission", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({ sink, agentId: "@test:example" });

    await emitter.record(
      {
        toolName: "matrix/send",
        redaction: { args: ["access_token"] },
        args: { room: "!abc:x", body: "hi", access_token: "super-secret" },
      },
      async () => ({ event_id: "$evt" }),
    );

    const args = sink.records[0]?.args as Record<string, unknown>;
    expect(args.access_token).toBe(REDACTION_SENTINEL);
    expect(args.body).toBe("hi");
    expect(args.room).toBe("!abc:x");
  });

  test("applies result redaction before emission", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({ sink, agentId: "@test:example" });

    await emitter.record(
      {
        toolName: "gopass/show",
        redaction: { result: ["value"] },
        args: { path: "services/foo" },
      },
      async () => ({ value: "not-a-secret-in-a-test", path: "services/foo" }),
    );

    const result = sink.records[0]?.result as Record<string, unknown>;
    expect(result.value).toBe(REDACTION_SENTINEL);
    expect(result.path).toBe("services/foo");
  });

  test("threads parentEventId and rootEventId into records", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({
      sink,
      agentId: "@test:example",
      generateEventId: () => "child",
      parentEventId: "11111111-1111-4111-8111-111111111111",
      rootEventId: "22222222-2222-4222-8222-222222222222",
    });

    await emitter.record({ toolName: "demo/nested" }, async () => 1);

    const record = sink.records[0];
    if (!record) throw new Error("expected one record");
    expect(record.event_id).toBe("child");
    expect(record.parent_event_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(record.root_event_id).toBe("22222222-2222-4222-8222-222222222222");
  });

  test("swallows sink errors but still returns / rethrows tool result", async () => {
    const brokenSink = {
      async emit() {
        throw new Error("sink down");
      },
    };
    const emitter = new TraceEmitter({ sink: brokenSink, agentId: "@test:example" });

    const ok = await emitter.record({ toolName: "demo/ok" }, async () => "value");
    expect(ok).toBe("value");

    await expect(
      emitter.record({ toolName: "demo/bad" }, async () => {
        throw new Error("tool err");
      }),
    ).rejects.toThrow("tool err");
  });

  test("tags are carried through when present", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({ sink, agentId: "@test:example" });
    await emitter.record({ toolName: "demo/tagged", tags: ["agent-internal"] }, async () => 1);
    expect(sink.records[0]?.tags).toEqual(["agent-internal"]);
  });
});

describe("wrapToolWithTrace", () => {
  const baseTool: ToolDefinition = {
    name: "demo/echo",
    description: "echo",
    keywords: ["echo"],
    invoke: async (input) => input,
    redaction: { args: ["secret"] },
  };

  test("returns a new tool observationally equivalent to the input", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({ sink, agentId: "@test:example" });
    const wrapped = wrapToolWithTrace(baseTool, emitter);

    expect(wrapped.name).toBe(baseTool.name);
    expect(wrapped.description).toBe(baseTool.description);
    expect(wrapped.keywords).toEqual(baseTool.keywords ?? []);
    expect(wrapped.redaction).toEqual(baseTool.redaction);

    const out = await wrapped.invoke({ secret: "s", msg: "hi" });
    // Real invoke sees un-redacted input.
    expect(out).toEqual({ secret: "s", msg: "hi" });
  });

  test("emits a redacted record on each invocation", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({ sink, agentId: "@test:example" });
    const wrapped = wrapToolWithTrace(baseTool, emitter, ["wrapped"]);

    await wrapped.invoke({ secret: "s", msg: "hi" });
    await wrapped.invoke({ secret: "t", msg: "yo" });

    expect(sink.records).toHaveLength(2);
    for (const record of sink.records) {
      const args = record.args as Record<string, unknown>;
      expect(args.secret).toBe(REDACTION_SENTINEL);
      expect(record.tags).toEqual(["wrapped"]);
    }
  });
});

describe("createJsonlFileSink", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agents-js-trace-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("appends one line per record and creates parent directories", async () => {
    const logPath = join(tmpDir, "nested", "trace.jsonl");
    const sink = createJsonlFileSink(logPath);

    const record: ToolCallTrace = {
      schema_version: TOOL_CALL_TRACE_SCHEMA_VERSION,
      event_id: "e1",
      timestamp: "2026-04-22T00:00:00.000Z",
      agent_id: "@test:example",
      session_id: null,
      tool_name: "demo/one",
      duration_ms: 10,
      status: "ok",
      parent_event_id: null,
      root_event_id: "e1",
    };
    await sink.emit(record);
    await sink.emit({ ...record, event_id: "e2", tool_name: "demo/two", root_event_id: "e2" });

    const text = readFileSync(logPath, "utf-8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as ToolCallTrace);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.event_id).toBe("e1");
    expect(parsed[1]?.event_id).toBe("e2");
  });

  test("serializes concurrent emits without interleaving", async () => {
    const logPath = join(tmpDir, "concurrent.jsonl");
    const sink = createJsonlFileSink(logPath);
    const record = (id: string): ToolCallTrace => ({
      schema_version: TOOL_CALL_TRACE_SCHEMA_VERSION,
      event_id: id,
      timestamp: "2026-04-22T00:00:00.000Z",
      agent_id: "@test:example",
      session_id: null,
      tool_name: "demo/x",
      duration_ms: 0,
      status: "ok",
      parent_event_id: null,
      root_event_id: id,
    });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        sink.emit(record(`evt-${i.toString().padStart(2, "0")}`)),
      ),
    );
    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(10);
    const ids = lines.map((line) => (JSON.parse(line) as ToolCallTrace).event_id);
    // With a serialized chain, every line parses and every emit lands.
    expect(new Set(ids).size).toBe(10);
  });
});

describe("validateCompositionId", () => {
  test("accepts null and undefined as 'no id'", () => {
    expect(validateCompositionId(null, "parentEventId")).toBeNull();
    expect(validateCompositionId(undefined, "parentEventId")).toBeNull();
  });

  test("accepts a well-formed UUID v4", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(validateCompositionId(uuid, "parentEventId")).toBe(uuid);
  });

  test("accepts a well-formed ULID", () => {
    const ulid = "01HXYZK9ABCD1234567890ABCD";
    expect(validateCompositionId(ulid, "rootEventId")).toBe(ulid);
  });

  test("drops malformed ids to null and warns on stderr", () => {
    expect(validateCompositionId("not-a-valid-id", "parentEventId")).toBeNull();
    expect(validateCompositionId("too-short", "rootEventId")).toBeNull();
  });
});

describe("safeSerializeRecord — unserializable args/result fallback", () => {
  function baseRecord(): ToolCallTrace {
    return {
      schema_version: TOOL_CALL_TRACE_SCHEMA_VERSION,
      event_id: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-04-22T00:00:00.000Z",
      agent_id: "@test:example",
      session_id: null,
      tool_name: "demo/fn",
      duration_ms: 1,
      status: "ok",
      parent_event_id: null,
      root_event_id: "11111111-1111-4111-8111-111111111111",
    };
  }

  test("native-serializable record round-trips unchanged", () => {
    const record = { ...baseRecord(), args: { a: 1 }, result: "hi" };
    const parsed = JSON.parse(safeSerializeRecord(record)) as ToolCallTrace;
    expect(parsed.args).toEqual({ a: 1 });
    expect(parsed.result).toBe("hi");
  });

  test("function field in args replaced with per-field sentinel, lineage preserved", () => {
    const record = { ...baseRecord(), args: { callback: () => "nope", keepMe: "value" } };
    const parsed = JSON.parse(safeSerializeRecord(record)) as ToolCallTrace;
    // Lineage survives
    expect(parsed.event_id).toBe(record.event_id);
    expect(parsed.tool_name).toBe("demo/fn");
    // The replacer walks args recursively — the bad field is sentinel'd but
    // the rest of the object round-trips normally. Keeps observability
    // partial rather than dropping the entire args payload.
    const args = parsed.args as { callback: unknown; keepMe: string };
    expect(args.callback).toEqual({ __unserializable: "function" });
    expect(args.keepMe).toBe("value");
  });

  test("circular ref in result falls back to whole-field circular sentinel", () => {
    const circ: Record<string, unknown> = { name: "root" };
    circ.self = circ;
    const record = { ...baseRecord(), result: circ };
    const parsed = JSON.parse(safeSerializeRecord(record)) as ToolCallTrace;
    expect(parsed.event_id).toBe(record.event_id);
    // Circular refs throw in stringify even with a replacer; fallback path
    // replaces the whole result field rather than attempting partial walk.
    expect(parsed.result).toEqual({ __unserializable: "circular-or-nested" });
  });

  test("bigint field in args replaced with per-field sentinel", () => {
    const record = { ...baseRecord(), args: { id: 42n as unknown } };
    const parsed = JSON.parse(safeSerializeRecord(record)) as ToolCallTrace;
    const args = parsed.args as { id: unknown };
    expect(args.id).toEqual({ __unserializable: "bigint" });
  });
});

describe("createNoopSink", () => {
  test("discards records without error", async () => {
    const sink = createNoopSink();
    await sink.emit({
      schema_version: TOOL_CALL_TRACE_SCHEMA_VERSION,
      event_id: "e",
      timestamp: "2026-04-22T00:00:00.000Z",
      agent_id: "@test:example",
      session_id: null,
      tool_name: "demo/noop",
      duration_ms: 0,
      status: "ok",
      parent_event_id: null,
      root_event_id: "e",
    });
    // No assertion needed — success is not throwing.
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 3, 22, 0, 0, 0) + tick++ * 5);
}
