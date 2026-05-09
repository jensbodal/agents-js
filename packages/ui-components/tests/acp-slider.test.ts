import { describe, expect, test } from "bun:test";
import { AcpSlider, registerAllComponents } from "../src/index.ts";

describe("AcpSlider", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpSlider).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpSlider.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpSlider.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for value, min, max, step, disabled, label", () => {
    const props = AcpSlider.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("value")).toBeDefined();
    expect(props.get("min")).toBeDefined();
    expect(props.get("max")).toBeDefined();
    expect(props.get("step")).toBeDefined();
    expect(props.get("disabled")).toBeDefined();
    expect(props.get("label")).toBeDefined();
  });

  test("value property has Number type", () => {
    expect(AcpSlider.elementProperties.get("value")?.type).toBe(Number);
  });

  test("min property has Number type", () => {
    expect(AcpSlider.elementProperties.get("min")?.type).toBe(Number);
  });

  test("max property has Number type", () => {
    expect(AcpSlider.elementProperties.get("max")?.type).toBe(Number);
  });

  test("step property has Number type", () => {
    expect(AcpSlider.elementProperties.get("step")?.type).toBe(Number);
  });

  test("disabled property has Boolean type", () => {
    expect(AcpSlider.elementProperties.get("disabled")?.type).toBe(Boolean);
  });

  test("label property has String type", () => {
    expect(AcpSlider.elementProperties.get("label")?.type).toBe(String);
  });
});

describe("AcpSlider behavior", () => {
  test("_handleInput updates value and dispatches acp-change with numeric value", () => {
    const instance = new AcpSlider() as AcpSlider & {
      _handleInput(e: Event): void;
    };
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleInput({ target: { value: "75" } } as unknown as Event);
    expect(instance.value).toBe(75);
    expect(events.length).toBe(1);
    expect(events[0].detail).toEqual({ value: 75 });
  });

  test("_handleInput converts string input value to number", () => {
    const instance = new AcpSlider() as AcpSlider & {
      _handleInput(e: Event): void;
    };
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleInput({ target: { value: "42" } } as unknown as Event);
    expect(typeof instance.value).toBe("number");
    expect(instance.value).toBe(42);
    expect(typeof events[0].detail.value).toBe("number");
  });
});
