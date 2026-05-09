export interface A2ALogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createConsoleLogger(tag: string): A2ALogger {
  return {
    info: (msg, data) => console.log(`[${tag}] ${msg}`, data ? JSON.stringify(data) : ""),
    warn: (msg, data) => console.warn(`[${tag}] ${msg}`, data ? JSON.stringify(data) : ""),
    error: (msg, data) => console.error(`[${tag}] ${msg}`, data ? JSON.stringify(data) : ""),
  };
}
