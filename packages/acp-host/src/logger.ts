import type { ContentBlock } from "@agentclientprotocol/sdk";

export type LogCategory =
  | "session"
  | "permission"
  | "terminal"
  | "file"
  | "error"
  | "debug"
  | "mcp-server";
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogEntry {
  timestamp: number;
  category: LogCategory;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
  sessionId?: string;
  requestId?: string;
}

// -- Configurable logging harness ---------------------------------------------

/**
 * Sink for structured log entries. Implementors handle each `LogEntry`
 * synchronously (any async work must be self-managed) and decide where it
 * goes — console, span buffer, eval transport, or a host-supplied custom
 * sink. The host wires its preferred transport into the global Logger via
 * {@link configureLogging}.
 */
export interface LogTransport {
  handle(entry: LogEntry): void;
}

export interface LoggerConfig {
  minLevel?: LogLevel;
  transports?: LogTransport[];
  contextProvider?: () => { sessionId?: string; requestId?: string };
}

let globalLogConfig: LoggerConfig = {};

export function configureLogging(config: LoggerConfig): void {
  globalLogConfig = {
    minLevel: config.minLevel ?? globalLogConfig.minLevel,
    transports: [...(globalLogConfig.transports ?? []), ...(config.transports ?? [])],
    contextProvider: config.contextProvider ?? globalLogConfig.contextProvider,
  };
}

export function resetLogging(): void {
  globalLogConfig = {};
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

// -- Log store ----------------------------------------------------------------

type LogStoreListener = (entry: LogEntry) => void;

const MAX_ENTRIES = 500;

/**
 * Singleton ring-buffer backed log store.
 * Captures all Logger output for the debug panel.
 */
class LogStoreImpl {
  private entries: LogEntry[] = [];
  private listeners = new Set<LogStoreListener>();

  push(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Ignore listener errors
      }
    }
  }

  getAll(): ReadonlyArray<LogEntry> {
    return this.entries;
  }

  getFiltered(categories?: LogCategory[], levels?: LogLevel[]): LogEntry[] {
    return this.entries.filter((e) => {
      if (categories && categories.length > 0 && !categories.includes(e.category)) {
        return false;
      }
      if (levels && levels.length > 0 && !levels.includes(e.level)) {
        return false;
      }
      return true;
    });
  }

  subscribe(listener: LogStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.entries = [];
  }

  /** For testing: get current entry count */
  get size(): number {
    return this.entries.length;
  }
}

/**
 * Singleton log store instance.
 */
export const logStore = new LogStoreImpl();

/**
 * Structured console logger with category prefixes.
 * Provides debug visibility for session lifecycle, permissions, and errors.
 * All log calls are also pushed to the global logStore for the debug panel.
 */
export class Logger {
  private category: LogCategory;

  constructor(category: LogCategory) {
    this.category = category;
  }

  private shouldLog(level: LogLevel): boolean {
    const min = globalLogConfig.minLevel ?? "debug";
    return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[min];
  }

  private emit(
    level: LogLevel,
    consoleFn: (...args: unknown[]) => void,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    if (!this.shouldLog(level)) return;

    consoleFn(`[ACP:${this.category}] ${message}`, data ?? "");

    const entry: LogEntry = {
      timestamp: Date.now(),
      category: this.category,
      level,
      message,
      data,
    };

    if (globalLogConfig.contextProvider) {
      try {
        const ctx = globalLogConfig.contextProvider();
        if (ctx.sessionId) entry.sessionId = ctx.sessionId;
        if (ctx.requestId) entry.requestId = ctx.requestId;
      } catch {
        /* contextProvider errors must not break logging */
      }
    }

    logStore.push(entry);

    for (const transport of globalLogConfig.transports ?? []) {
      try {
        transport.handle(entry);
      } catch {
        /* swallow transport errors */
      }
    }
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.emit("info", console.log, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.emit("warn", console.warn, message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.emit("error", console.error, message, data);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.emit("debug", console.debug, message, data);
  }
}

// -- Span-based log transport -------------------------------------------------

export interface Span {
  requestId: string;
  sessionId?: string;
  startedAt: number;
  entries: LogEntry[];
  completedAt?: number;
}

export type ReadonlySpan = Readonly<Omit<Span, "entries">> & {
  readonly entries: ReadonlyArray<LogEntry>;
};

/**
 * `LogTransport` that buckets entries into spans keyed by `entry.spanId`,
 * tracking active and completed spans for the debug panel and trace export.
 */
export class SpanLogTransport implements LogTransport {
  private spans = new Map<string, Span>();
  private completedSpans: Span[] = [];
  private maxCompleted: number;

  constructor(maxCompleted = 100) {
    this.maxCompleted = maxCompleted;
  }

  handle(entry: LogEntry): void {
    if (!entry.requestId) return;

    let span = this.spans.get(entry.requestId);
    if (!span) {
      span = {
        requestId: entry.requestId,
        sessionId: entry.sessionId,
        startedAt: entry.timestamp,
        entries: [],
      };
      this.spans.set(entry.requestId, span);
    }
    span.entries.push(entry);
  }

  completeSpan(requestId: string): ReadonlySpan | undefined {
    const span = this.spans.get(requestId);
    if (!span) return undefined;

    span.completedAt = Date.now();
    this.spans.delete(requestId);
    this.completedSpans.push(span);
    if (this.completedSpans.length > this.maxCompleted) {
      this.completedSpans.shift();
    }
    return span;
  }

  getActiveSpans(): ReadonlySpan[] {
    return [...this.spans.values()];
  }

  getCompletedSpans(): ReadonlySpan[] {
    return [...this.completedSpans];
  }

  clear(): void {
    this.spans.clear();
    this.completedSpans = [];
  }
}

// -- Eval transport -----------------------------------------------------------

export interface EvalRecord {
  sessionId: string;
  requestId: string;
  timestamp: number;
  promptContent: ContentBlock[];
  userMessageId?: string;
  agentMessageId?: string;
  responseText: string;
  stopReason: string;
  durationMs: number;
  agentName?: string;
  errors?: Array<{ message: string; category: string; data?: Record<string, unknown> }>;
}

/**
 * `LogTransport` that captures per-prompt evaluation records (prompt
 * content, response, stop reason, errors) for offline regression suites.
 */
export class EvalTransport implements LogTransport {
  private records: EvalRecord[] = [];
  private maxRecords: number;
  private errorBuffer = new Map<string, LogEntry[]>();
  private maxErrorsPerRequest = 20;

  constructor(maxRecords = 1000) {
    this.maxRecords = maxRecords;
  }

  handle(entry: LogEntry): void {
    if (entry.level === "error" && entry.requestId) {
      const errors = this.errorBuffer.get(entry.requestId) ?? [];
      errors.push(entry);
      if (errors.length > this.maxErrorsPerRequest) errors.shift();
      this.errorBuffer.set(entry.requestId, errors);
    }
  }

  addRecord(record: EvalRecord): void {
    const errors = this.errorBuffer.get(record.requestId);
    if (errors?.length) {
      record.errors = errors.map((e) => ({
        message: e.message,
        category: e.category,
        data: e.data,
      }));
      this.errorBuffer.delete(record.requestId);
    }
    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.shift();
    }
  }

  getRecords(): ReadonlyArray<EvalRecord> {
    return this.records;
  }

  toJsonl(): string {
    return this.records.map((r) => JSON.stringify(r)).join("\n");
  }

  clear(): void {
    this.records = [];
    this.errorBuffer.clear();
  }
}
