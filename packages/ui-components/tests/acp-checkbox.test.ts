import { describe, expect, test } from "bun:test";
import { AcpCheckbox, registerAllComponents } from "../src/index.ts";

describe("AcpCheckbox", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpCheckbox).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpCheckbox.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpCheckbox.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for checked, disabled, label, indeterminate", () => {
    const props = AcpCheckbox.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("checked")).toBeDefined();
    expect(props.get("disabled")).toBeDefined();
    expect(props.get("label")).toBeDefined();
    expect(props.get("indeterminate")).toBeDefined();
  });

  test("checked property has Boolean type", () => {
    expect(AcpCheckbox.elementProperties.get("checked")?.type).toBe(Boolean);
  });

  test("disabled property has Boolean type", () => {
    expect(AcpCheckbox.elementProperties.get("disabled")?.type).toBe(Boolean);
  });

  test("label property has String type", () => {
    expect(AcpCheckbox.elementProperties.get("label")?.type).toBe(String);
  });

  test("indeterminate property has Boolean type", () => {
    expect(AcpCheckbox.elementProperties.get("indeterminate")?.type).toBe(Boolean);
  });
});

describe("AcpCheckbox behavior", () => {
  test("_handleClick toggles checked and dispatches acp-change with detail.checked", () => {
    const instance = new AcpCheckbox() as AcpCheckbox & {
      _handleClick(): void;
    };
    instance.checked = false;
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleClick();
    expect(instance.checked).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].detail).toEqual({ checked: true });
  });

  test("_handleClick toggles checked from true to false", () => {
    const instance = new AcpCheckbox() as AcpCheckbox & {
      _handleClick(): void;
    };
    instance.checked = true;
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleClick();
    expect(instance.checked).toBe(false);
    expect(events[0].detail).toEqual({ checked: false });
  });

  test("_handleClick does nothing when disabled", () => {
    const instance = new AcpCheckbox() as AcpCheckbox & {
      _handleClick(): void;
    };
    instance.checked = false;
    instance.disabled = true;
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleClick();
    expect(instance.checked).toBe(false);
    expect(events.length).toBe(0);
  });

  test("_handleClick clears indeterminate state on toggle", () => {
    const instance = new AcpCheckbox() as AcpCheckbox & {
      _handleClick(): void;
    };
    instance.indeterminate = true;
    instance.checked = false;
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleClick();
    expect(instance.indeterminate).toBe(false);
    expect(instance.checked).toBe(true);
    expect(events[0].detail).toEqual({ checked: true });
  });
});
