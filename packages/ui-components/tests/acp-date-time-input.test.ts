import { describe, expect, test } from "bun:test";
import { AcpDateTimeInput, registerAllComponents } from "../src/index.ts";

describe("AcpDateTimeInput", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpDateTimeInput).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpDateTimeInput.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpDateTimeInput.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for value, mode, disabled, label, min, max", () => {
    const props = AcpDateTimeInput.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("value")).toBeDefined();
    expect(props.get("mode")).toBeDefined();
    expect(props.get("disabled")).toBeDefined();
    expect(props.get("label")).toBeDefined();
    expect(props.get("min")).toBeDefined();
    expect(props.get("max")).toBeDefined();
  });

  test("value property has String type", () => {
    expect(AcpDateTimeInput.elementProperties.get("value")?.type).toBe(String);
  });

  test("mode property has String type", () => {
    expect(AcpDateTimeInput.elementProperties.get("mode")?.type).toBe(String);
  });

  test("disabled property has Boolean type", () => {
    expect(AcpDateTimeInput.elementProperties.get("disabled")?.type).toBe(Boolean);
  });

  test("label property has String type", () => {
    expect(AcpDateTimeInput.elementProperties.get("label")?.type).toBe(String);
  });

  test("min property has String type", () => {
    expect(AcpDateTimeInput.elementProperties.get("min")?.type).toBe(String);
  });

  test("max property has String type", () => {
    expect(AcpDateTimeInput.elementProperties.get("max")?.type).toBe(String);
  });
});

describe("AcpDateTimeInput behavior", () => {
  test("_handleChange dispatches acp-change with value in detail", () => {
    const instance = new AcpDateTimeInput() as AcpDateTimeInput & {
      _handleChange(e: Event): void;
    };
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleChange({ target: { value: "2026-04-05T10:30" } } as unknown as Event);
    expect(instance.value).toBe("2026-04-05T10:30");
    expect(events.length).toBe(1);
    expect(events[0].detail).toEqual({ value: "2026-04-05T10:30" });
  });

  test("_handleInput updates value but does not dispatch acp-change", () => {
    const instance = new AcpDateTimeInput() as AcpDateTimeInput & {
      _handleInput(e: Event): void;
    };
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleInput({ target: { value: "2026-01-01" } } as unknown as Event);
    expect(instance.value).toBe("2026-01-01");
    expect(events.length).toBe(0);
  });

  test("_handleChange emits exactly one event per change (no duplicates)", () => {
    const instance = new AcpDateTimeInput() as AcpDateTimeInput & {
      _handleChange(e: Event): void;
    };
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleChange({ target: { value: "2026-06-15T14:00" } } as unknown as Event);
    expect(events.length).toBe(1);
    expect(events[0].detail).toEqual({ value: "2026-06-15T14:00" });
  });

  test("_inputType returns correct type for each mode", () => {
    const instance = new AcpDateTimeInput() as AcpDateTimeInput & {
      _inputType(): string;
    };

    instance.mode = "date";
    expect(instance._inputType()).toBe("date");

    instance.mode = "time";
    expect(instance._inputType()).toBe("time");

    instance.mode = "datetime";
    expect(instance._inputType()).toBe("datetime-local");
  });
});
