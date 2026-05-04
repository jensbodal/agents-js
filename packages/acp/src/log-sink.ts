export interface LogSink {
  error(message: string): void;
  warn(message: string): void;
}

export const consoleLogSink: LogSink = {
  error: (msg) => console.error(msg),
  warn: (msg) => console.warn(msg),
};
