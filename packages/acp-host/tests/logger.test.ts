import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  configureLogging,
  EvalTransport,
  type LogEntry,
  Logger,
  type LogTransport,
  logStore,
  resetLogging,
  SpanLogTransport,
} from "../src/logger.ts";

describe("Logger", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Defend against sibling test files that mutate globalLogConfig (e.g.
    // session-defaults.test.ts, session-updates.test.ts set minLevel:"silent").
    // Without this reset, a polluted minLevel causes Logger.info/warn/error
    // calls to short-circuit and these spy assertions fail.
    resetLogging();
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test("info logs with category prefix", () => {
    const logger = new Logger("session");
    logger.info("test message");
    expect(consoleSpy).toHaveBeenCalledWith("[ACP:session] test message", "");
  });

  test("info logs with data", () => {
    const logger = new Logger("permission");
    const data = { key: "value" };
    logger.info("test", data);
    expect(consoleSpy).toHaveBeenCalledWith("[ACP:permission] test", data);
  });

  test("warn uses console.warn", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const logger = new Logger("error");
    logger.warn("warning message");
    expect(warnSpy).toHaveBeenCalledWith("[ACP:error] warning message", "");
    warnSpy.mockRestore();
  });

  test("error uses console.error", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const logger = new Logger("terminal");
    logger.error("error message");
    expect(errorSpy).toHaveBeenCalledWith("[ACP:terminal] error message", "");
    errorSpy.mockRestore();
  });

  test("debug uses console.debug", () => {
    const debugSpy = spyOn(console, "debug").mockImplementation(() => {});
    const logger = new Logger("file");
    logger.debug("debug message");
    expect(debugSpy).toHaveBeenCalledWith("[ACP:file] debug message", "");
    debugSpy.mockRestore();
  });
});

describe("LogStore", () => {
  beforeEach(() => {
    // Same defensive reset as the Logger describe above. logStore.push is
    // only reached if shouldLog() passes, which depends on globalLogConfig.
    resetLogging();
    logStore.clear();
    // Suppress console output during logStore tests
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(console, "debug").mockImplementation(() => {});
  });

  test("push adds entries and getAll retrieves them", () => {
    const logger = new Logger("session");
    logger.info("msg1");
    logger.info("msg2");

    const all = logStore.getAll();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const ours = all.filter((e) => e.message === "msg1" || e.message === "msg2");
    expect(ours.length).toBe(2);
  });

  test("max entries enforced (ring buffer behavior)", () => {
    logStore.clear();
    const logger = new Logger("session");

    for (let i = 0; i < 510; i++) {
      logger.info(`entry-${i}`);
    }

    expect(logStore.size).toBe(500);
    const all = logStore.getAll();
    expect(all[0]?.message).toBe("entry-10");
    expect(all[all.length - 1]?.message).toBe("entry-509");
  });

  test("getFiltered filters by category", () => {
    logStore.clear();
    const sessionLogger = new Logger("session");
    const fileLogger = new Logger("file");

    sessionLogger.info("session msg");
    fileLogger.info("file msg");

    const filtered = logStore.getFiltered(["session"]);
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.category).toBe("session");
    expect(filtered[0]?.message).toBe("session msg");
  });

  test("getFiltered filters by level", () => {
    logStore.clear();
    const logger = new Logger("session");

    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    const filtered = logStore.getFiltered(undefined, ["warn", "error"]);
    expect(filtered.length).toBe(2);
    expect(filtered.every((e) => e.level === "warn" || e.level === "error")).toBe(true);
  });

  test("getFiltered filters by both category and level", () => {
    logStore.clear();
    const sessionLogger = new Logger("session");
    const fileLogger = new Logger("file");

    sessionLogger.info("session info");
    sessionLogger.error("session error");
    fileLogger.error("file error");

    const filtered = logStore.getFiltered(["session"], ["error"]);
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.message).toBe("session error");
  });

  test("getFiltered with empty arrays returns all", () => {
    logStore.clear();
    const logger = new Logger("session");
    logger.info("msg");

    const filtered = logStore.getFiltered([], []);
    expect(filtered.length).toBe(1);
  });

  test("subscribe receives new entries", () => {
    const received: string[] = [];
    const unsub = logStore.subscribe((entry) => {
      received.push(entry.message);
    });

    const logger = new Logger("session");
    logger.info("live msg");

    expect(received).toContain("live msg");
    unsub();
  });

  test("unsubscribed listener does not receive entries", () => {
    const received: string[] = [];
    const unsub = logStore.subscribe((entry) => {
      received.push(entry.message);
    });
    unsub();

    const logger = new Logger("session");
    logger.info("after unsub");

    expect(received).not.toContain("after unsub");
  });

  test("clear removes all entries", () => {
    const logger = new Logger("session");
    logger.info("before clear");

    logStore.clear();
    expect(logStore.size).toBe(0);
    expect(logStore.getAll().length).toBe(0);
  });

  test("entries have correct structure", () => {
    logStore.clear();
    const logger = new Logger("terminal");
    const data = { pid: 123 };
    logger.warn("process warning", data);

    const entries = logStore.getAll();
    expect(entries.length).toBe(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one log entry");
    expect(entry.category).toBe("terminal");
    expect(entry.level).toBe("warn");
    expect(entry.message).toBe("process warning");
    expect(entry.data).toEqual(data);
    expect(typeof entry.timestamp).toBe("number");
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  test("Logger pushes all log levels to logStore", () => {
    logStore.clear();
    const logger = new Logger("debug");

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    const all = logStore.getAll();
    expect(all.length).toBe(4);
    expect(all.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
  });
});

describe("configureLogging", () => {
  beforeEach(() => {
    logStore.clear();
    resetLogging();
    // Suppress console output
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    // Reset to default config after each test
    resetLogging();
  });

  test("minLevel: warn suppresses debug and info", () => {
    configureLogging({ minLevel: "warn" });
    const logger = new Logger("session");

    logger.debug("should not appear");
    logger.info("should not appear either");
    logger.warn("should appear");
    logger.error("should also appear");

    const all = logStore.getAll();
    expect(all.length).toBe(2);
    expect(all.map((e) => e.level)).toEqual(["warn", "error"]);
  });

  test("minLevel: error suppresses debug, info, and warn", () => {
    configureLogging({ minLevel: "error" });
    const logger = new Logger("session");

    logger.debug("no");
    logger.info("no");
    logger.warn("no");
    logger.error("yes");

    const all = logStore.getAll();
    expect(all.length).toBe(1);
    expect(all[0]?.level).toBe("error");
  });

  test("transports receive LogEntry objects", () => {
    const received: LogEntry[] = [];
    const mockTransport: LogTransport = {
      handle(entry: LogEntry) {
        received.push(entry);
      },
    };

    configureLogging({ transports: [mockTransport] });
    const logger = new Logger("session");
    logger.info("transport test", { key: "val" });

    expect(received.length).toBe(1);
    expect(received[0]?.message).toBe("transport test");
    expect(received[0]?.level).toBe("info");
    expect(received[0]?.category).toBe("session");
    expect(received[0]?.data).toEqual({ key: "val" });
  });

  test("transport errors do not crash the logger", () => {
    const throwingTransport: LogTransport = {
      handle() {
        throw new Error("transport failure");
      },
    };
    const received: LogEntry[] = [];
    const safeTransport: LogTransport = {
      handle(entry: LogEntry) {
        received.push(entry);
      },
    };

    configureLogging({ transports: [throwingTransport, safeTransport] });
    const logger = new Logger("session");

    // Should not throw, and subsequent transports still execute
    expect(() => logger.info("after throwing transport")).not.toThrow();
    expect(received.length).toBe(1);
    expect(received[0]?.message).toBe("after throwing transport");
  });

  test("reset with empty config restores all levels (backward compat)", () => {
    configureLogging({ minLevel: "error" });
    const logger = new Logger("session");

    logger.debug("suppressed");
    expect(logStore.getAll().length).toBe(0);

    // Reset
    resetLogging();

    logger.debug("now visible");
    logger.info("also visible");
    logger.warn("also visible");
    logger.error("also visible");

    const all = logStore.getAll();
    expect(all.length).toBe(4);
    expect(all.map((e) => e.level)).toEqual(["debug", "info", "warn", "error"]);
  });

  test("logStore still receives entries when transports are configured", () => {
    const transportReceived: LogEntry[] = [];
    const mockTransport: LogTransport = {
      handle(entry: LogEntry) {
        transportReceived.push(entry);
      },
    };

    configureLogging({ transports: [mockTransport] });
    const logger = new Logger("session");
    logger.info("both stores");

    // Both logStore and transport should have the entry
    const storeEntries = logStore.getAll();
    expect(storeEntries.length).toBe(1);
    expect(storeEntries[0]?.message).toBe("both stores");

    expect(transportReceived.length).toBe(1);
    expect(transportReceived[0]?.message).toBe("both stores");
  });

  test("minLevel combined with transports filters correctly", () => {
    const received: LogEntry[] = [];
    const mockTransport: LogTransport = {
      handle(entry: LogEntry) {
        received.push(entry);
      },
    };

    configureLogging({ minLevel: "warn", transports: [mockTransport] });
    const logger = new Logger("session");

    logger.debug("suppressed");
    logger.info("suppressed");
    logger.warn("passed");
    logger.error("passed");

    // Both logStore and transport should only have warn+error
    expect(logStore.getAll().length).toBe(2);
    expect(received.length).toBe(2);
    expect(received.map((e) => e.level)).toEqual(["warn", "error"]);
  });
});

describe("LogEntry with sessionId and requestId", () => {
  beforeEach(() => {
    logStore.clear();
    resetLogging();
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    resetLogging();
  });

  test("contextProvider auto-injects sessionId and requestId into entries", () => {
    const received: LogEntry[] = [];
    const mockTransport: LogTransport = {
      handle(entry: LogEntry) {
        received.push(entry);
      },
    };

    configureLogging({
      transports: [mockTransport],
      contextProvider: () => ({ sessionId: "sess-42", requestId: "req-99" }),
    });

    const logger = new Logger("session");
    logger.info("contextual log");

    expect(received.length).toBe(1);
    expect(received[0]?.sessionId).toBe("sess-42");
    expect(received[0]?.requestId).toBe("req-99");
  });

  test("entries without contextProvider have no sessionId/requestId", () => {
    const received: LogEntry[] = [];
    const mockTransport: LogTransport = {
      handle(entry: LogEntry) {
        received.push(entry);
      },
    };

    configureLogging({ transports: [mockTransport] });

    const logger = new Logger("session");
    logger.info("no context");

    expect(received.length).toBe(1);
    expect(received[0]?.sessionId).toBeUndefined();
    expect(received[0]?.requestId).toBeUndefined();
  });

  test("contextProvider with partial context only sets provided fields", () => {
    const received: LogEntry[] = [];
    const mockTransport: LogTransport = {
      handle(entry: LogEntry) {
        received.push(entry);
      },
    };

    configureLogging({
      transports: [mockTransport],
      contextProvider: () => ({ sessionId: "sess-only" }),
    });

    const logger = new Logger("session");
    logger.info("partial context");

    expect(received.length).toBe(1);
    expect(received[0]?.sessionId).toBe("sess-only");
    expect(received[0]?.requestId).toBeUndefined();
  });
});

describe("SpanLogTransport", () => {
  test("groups entries by requestId", () => {
    const transport = new SpanLogTransport();

    transport.handle({
      timestamp: 1000,
      category: "session",
      level: "info",
      message: "start",
      requestId: "req-1",
      sessionId: "sess-1",
    });
    transport.handle({
      timestamp: 1001,
      category: "session",
      level: "info",
      message: "middle",
      requestId: "req-1",
    });
    transport.handle({
      timestamp: 1002,
      category: "session",
      level: "info",
      message: "other",
      requestId: "req-2",
    });

    const active = transport.getActiveSpans();
    expect(active.length).toBe(2);

    const span1 = active.find((s) => s.requestId === "req-1");
    expect(span1).toBeDefined();
    expect(span1?.entries.length).toBe(2);
    expect(span1?.sessionId).toBe("sess-1");
    expect(span1?.startedAt).toBe(1000);
  });

  test("completeSpan moves span to completed", () => {
    const transport = new SpanLogTransport();

    transport.handle({
      timestamp: 1000,
      category: "session",
      level: "info",
      message: "work",
      requestId: "req-1",
    });

    const span = transport.completeSpan("req-1");
    if (!span) throw new Error("expected span to exist");
    expect(span.completedAt).toBeDefined();
    if (span.completedAt === undefined) throw new Error("expected completedAt to be defined");
    expect(span.completedAt).toBeGreaterThanOrEqual(span.startedAt);

    expect(transport.getActiveSpans().length).toBe(0);
    expect(transport.getCompletedSpans().length).toBe(1);
  });

  test("completeSpan returns undefined for unknown requestId", () => {
    const transport = new SpanLogTransport();
    expect(transport.completeSpan("nonexistent")).toBeUndefined();
  });

  test("completed spans ring buffer respects maxCompleted", () => {
    const transport = new SpanLogTransport(2);

    for (let i = 0; i < 4; i++) {
      transport.handle({
        timestamp: 1000 + i,
        category: "session",
        level: "info",
        message: `span-${i}`,
        requestId: `req-${i}`,
      });
      transport.completeSpan(`req-${i}`);
    }

    const completed = transport.getCompletedSpans();
    expect(completed.length).toBe(2);
    const [first, second] = completed;
    if (!first || !second) throw new Error("expected two completed spans");
    expect(first.requestId).toBe("req-2");
    expect(second.requestId).toBe("req-3");
  });

  test("entries without requestId are ignored", () => {
    const transport = new SpanLogTransport();

    transport.handle({
      timestamp: 1000,
      category: "session",
      level: "info",
      message: "no request id",
    });

    expect(transport.getActiveSpans().length).toBe(0);
  });

  test("clear removes all spans", () => {
    const transport = new SpanLogTransport();

    transport.handle({
      timestamp: 1000,
      category: "session",
      level: "info",
      message: "work",
      requestId: "req-1",
    });
    transport.handle({
      timestamp: 1001,
      category: "session",
      level: "info",
      message: "work2",
      requestId: "req-2",
    });
    transport.completeSpan("req-1");

    transport.clear();
    expect(transport.getActiveSpans().length).toBe(0);
    expect(transport.getCompletedSpans().length).toBe(0);
  });
});

describe("EvalTransport", () => {
  test("addRecord stores records and getRecords retrieves them", () => {
    const transport = new EvalTransport();

    transport.addRecord({
      sessionId: "sess-1",
      requestId: "req-1",
      timestamp: Date.now(),
      promptContent: [{ type: "text", text: "hello" }],
      responseText: "world",
      stopReason: "end_turn",
      durationMs: 150,
      agentName: "test-agent",
    });

    const records = transport.getRecords();
    expect(records.length).toBe(1);
    const [record] = records;
    if (!record) throw new Error("expected one record");
    expect(record.sessionId).toBe("sess-1");
    expect(record.responseText).toBe("world");
    expect(record.agentName).toBe("test-agent");
  });

  test("toJsonl produces valid JSONL", () => {
    const transport = new EvalTransport();

    transport.addRecord({
      sessionId: "sess-1",
      requestId: "req-1",
      timestamp: 1000,
      promptContent: [{ type: "text", text: "hello" }],
      responseText: "world",
      stopReason: "end_turn",
      durationMs: 100,
    });
    transport.addRecord({
      sessionId: "sess-1",
      requestId: "req-2",
      timestamp: 2000,
      promptContent: [{ type: "text", text: "second" }],
      responseText: "response",
      stopReason: "end_turn",
      durationMs: 200,
    });

    const jsonl = transport.toJsonl();
    const lines = jsonl.split("\n");
    expect(lines.length).toBe(2);

    const [line0, line1] = lines;
    if (!line0 || !line1) throw new Error("expected two JSONL lines");
    const parsed0 = JSON.parse(line0);
    expect(parsed0.requestId).toBe("req-1");

    const parsed1 = JSON.parse(line1);
    expect(parsed1.requestId).toBe("req-2");
  });

  test("ring buffer trims when maxRecords exceeded", () => {
    const transport = new EvalTransport(3);

    for (let i = 0; i < 5; i++) {
      transport.addRecord({
        sessionId: "sess-1",
        requestId: `req-${i}`,
        timestamp: 1000 + i,
        promptContent: [{ type: "text", text: `prompt-${i}` }],
        responseText: `response-${i}`,
        stopReason: "end_turn",
        durationMs: 100,
      });
    }

    const records = transport.getRecords();
    expect(records.length).toBe(3);
    const [r0, r1, r2] = records;
    if (!r0 || !r1 || !r2) throw new Error("expected three records");
    expect(r0.requestId).toBe("req-2");
    expect(r1.requestId).toBe("req-3");
    expect(r2.requestId).toBe("req-4");
  });

  test("handle ignores non-error entries", () => {
    const transport = new EvalTransport();
    transport.handle({
      timestamp: 1000,
      category: "session",
      level: "info",
      message: "ignored",
    });

    expect(transport.getRecords().length).toBe(0);
  });

  test("handle buffers error entries and addRecord attaches them", () => {
    const transport = new EvalTransport();

    transport.handle({
      timestamp: 1000,
      category: "error",
      level: "error",
      message: "something broke",
      requestId: "req-1",
      data: { detail: "stack trace" },
    });
    transport.handle({
      timestamp: 1001,
      category: "session",
      level: "error",
      message: "another error",
      requestId: "req-1",
    });

    transport.addRecord({
      sessionId: "sess-1",
      requestId: "req-1",
      timestamp: 1002,
      promptContent: [{ type: "text", text: "hello" }],
      userMessageId: "user-msg-1",
      agentMessageId: "agent-msg-1",
      responseText: "world",
      stopReason: "end_turn",
      durationMs: 100,
    });

    const records = transport.getRecords();
    expect(records.length).toBe(1);
    const [record] = records;
    if (!record) throw new Error("expected one record");
    expect(record.userMessageId).toBe("user-msg-1");
    expect(record.agentMessageId).toBe("agent-msg-1");
    expect(record.errors).toBeDefined();
    expect(record.errors?.length).toBe(2);
    const [err0, err1] = record.errors ?? [];
    if (!err0 || !err1) throw new Error("expected two errors");
    expect(err0.message).toBe("something broke");
    expect(err0.data).toEqual({ detail: "stack trace" });
    expect(err1.message).toBe("another error");
  });

  test("handle ignores errors without requestId", () => {
    const transport = new EvalTransport();

    transport.handle({
      timestamp: 1000,
      category: "error",
      level: "error",
      message: "no request id error",
    });

    transport.addRecord({
      sessionId: "sess-1",
      requestId: "req-1",
      timestamp: 1001,
      promptContent: [{ type: "text", text: "hello" }],
      responseText: "world",
      stopReason: "end_turn",
      durationMs: 100,
    });

    const records = transport.getRecords();
    const [record] = records;
    if (!record) throw new Error("expected one record");
    expect(record.errors).toBeUndefined();
  });

  test("clear removes all records", () => {
    const transport = new EvalTransport();

    transport.addRecord({
      sessionId: "sess-1",
      requestId: "req-1",
      timestamp: 1000,
      promptContent: [{ type: "text", text: "hello" }],
      responseText: "world",
      stopReason: "end_turn",
      durationMs: 100,
    });

    expect(transport.getRecords().length).toBe(1);
    transport.clear();
    expect(transport.getRecords().length).toBe(0);
  });

  test("toJsonl returns empty string when no records", () => {
    const transport = new EvalTransport();
    expect(transport.toJsonl()).toBe("");
  });
});
