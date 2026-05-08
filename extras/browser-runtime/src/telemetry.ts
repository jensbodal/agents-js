export const TELEMETRY_EVENT_NAMES = [
  "browser.support",
  "model.selected",
  "model.init.start",
  "model.init.end",
  "model.cache.hit",
  "validation.failure",
  "repair.invoked",
  "tool.call",
  "device.lost",
  "worker.crash",
  "fallback.used",
  "user.dropoff",
  "decide.failure",
  "stream.failure",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export interface TelemetryEvent {
  name: TelemetryEventName;
  attrs: Record<string, unknown>;
  timestamp: number;
}

export interface Telemetry {
  emit(event: { name: TelemetryEventName; attrs: Record<string, unknown> }): void;
  snapshot(): TelemetryEvent[];
  clear(): void;
}

export function createInMemoryTelemetry(opts: { strict?: boolean } = {}): Telemetry {
  const buffer: TelemetryEvent[] = [];
  const allowed = new Set<string>(TELEMETRY_EVENT_NAMES);
  return {
    emit(event) {
      if (opts.strict && !allowed.has(event.name)) {
        throw new Error(`unknown telemetry event: ${event.name}`);
      }
      buffer.push({ ...event, timestamp: Date.now() });
    },
    snapshot() {
      return [...buffer];
    },
    clear() {
      buffer.length = 0;
    },
  };
}
