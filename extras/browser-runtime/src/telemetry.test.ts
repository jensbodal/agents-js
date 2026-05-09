import { describe, expect, it } from "bun:test";
import { createInMemoryTelemetry, type TelemetryEvent } from "./telemetry.ts";

describe("createInMemoryTelemetry", () => {
  it("records emitted events with timestamps", () => {
    const tel = createInMemoryTelemetry();
    tel.emit({ name: "model.init.start", attrs: { modelId: "Qwen-1.5B" } });
    tel.emit({ name: "validation.failure", attrs: { kind: "tool" } });
    const events: TelemetryEvent[] = tel.snapshot();
    expect(events.length).toBe(2);
    expect(events[0]?.name).toBe("model.init.start");
    expect(typeof events[0]?.timestamp).toBe("number");
  });

  it("clear() empties the buffer", () => {
    const tel = createInMemoryTelemetry();
    tel.emit({ name: "browser.support", attrs: { webgpu: true } });
    tel.clear();
    expect(tel.snapshot()).toEqual([]);
  });

  it("rejects unknown event names in dev", () => {
    const tel = createInMemoryTelemetry({ strict: true });
    // biome-ignore lint/suspicious/noExplicitAny: testing rejection of unknown event name
    expect(() => tel.emit({ name: "made.up" as any, attrs: {} })).toThrow(
      /unknown telemetry event/i,
    );
  });
});
