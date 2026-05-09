import { describe, expect, test } from "bun:test";
import { AcpChoicePicker, registerAllComponents } from "../src/index.ts";

describe("AcpChoicePicker", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpChoicePicker).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpChoicePicker.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpChoicePicker.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for options, value, multiple, disabled, label", () => {
    const props = AcpChoicePicker.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("options")).toBeDefined();
    expect(props.get("value")).toBeDefined();
    expect(props.get("multiple")).toBeDefined();
    expect(props.get("disabled")).toBeDefined();
    expect(props.get("label")).toBeDefined();
  });

  test("multiple property has Boolean type", () => {
    expect(AcpChoicePicker.elementProperties.get("multiple")?.type).toBe(Boolean);
  });

  test("disabled property has Boolean type", () => {
    expect(AcpChoicePicker.elementProperties.get("disabled")?.type).toBe(Boolean);
  });

  test("label property has String type", () => {
    expect(AcpChoicePicker.elementProperties.get("label")?.type).toBe(String);
  });
});

describe("AcpChoicePicker behavior", () => {
  test("_select in single mode sets value and dispatches acp-change", () => {
    const instance = new AcpChoicePicker() as AcpChoicePicker & {
      _select(v: string): void;
    };
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._select("opt-a");
    expect(instance.value).toBe("opt-a");
    expect(events.length).toBe(1);
    expect(events[0].detail).toEqual({ value: "opt-a" });
  });

  test("_select in multiple mode toggles values in array", () => {
    const instance = new AcpChoicePicker() as AcpChoicePicker & {
      _select(v: string): void;
    };
    instance.multiple = true;
    instance.value = [];
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);

    // Add first selection
    instance._select("opt-a");
    expect(instance.value).toEqual(["opt-a"]);
    expect(events[0].detail).toEqual({ value: ["opt-a"] });

    // Add second selection
    instance._select("opt-b");
    expect(instance.value).toEqual(["opt-a", "opt-b"]);
    expect(events[1].detail).toEqual({ value: ["opt-a", "opt-b"] });

    // Deselect first
    instance._select("opt-a");
    expect(instance.value).toEqual(["opt-b"]);
    expect(events[2].detail).toEqual({ value: ["opt-b"] });
  });

  test("_select does nothing when disabled", () => {
    const instance = new AcpChoicePicker() as AcpChoicePicker & {
      _select(v: string): void;
    };
    instance.disabled = true;
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._select("opt-a");
    expect(instance.value).toBe("");
    expect(events.length).toBe(0);
  });

  test("_isSelected returns correct result for single and multiple modes", () => {
    const instance = new AcpChoicePicker() as AcpChoicePicker & {
      _isSelected(v: string): boolean;
    };

    // Single mode
    instance.multiple = false;
    instance.value = "opt-a";
    expect(instance._isSelected("opt-a")).toBe(true);
    expect(instance._isSelected("opt-b")).toBe(false);

    // Multiple mode
    instance.multiple = true;
    instance.value = ["opt-a", "opt-c"];
    expect(instance._isSelected("opt-a")).toBe(true);
    expect(instance._isSelected("opt-b")).toBe(false);
    expect(instance._isSelected("opt-c")).toBe(true);
  });
});
