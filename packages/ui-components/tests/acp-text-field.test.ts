import { describe, expect, test } from "bun:test";
import { AcpTextField, registerAllComponents } from "../src/index.ts";

describe("AcpTextField", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpTextField).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpTextField.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpTextField.styles)).toBe(true);
  });

  test("registerAllComponents does not throw", () => {
    expect(() => registerAllComponents()).not.toThrow();
  });

  test("has reactive properties for value, placeholder, disabled, label, type, multiline, required, pattern, errorMessage", () => {
    const props = AcpTextField.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("value")).toBeDefined();
    expect(props.get("placeholder")).toBeDefined();
    expect(props.get("disabled")).toBeDefined();
    expect(props.get("label")).toBeDefined();
    expect(props.get("type")).toBeDefined();
    expect(props.get("multiline")).toBeDefined();
    expect(props.get("required")).toBeDefined();
    expect(props.get("pattern")).toBeDefined();
    expect(props.get("errorMessage")).toBeDefined();
  });

  test("value property has String type", () => {
    expect(AcpTextField.elementProperties.get("value")?.type).toBe(String);
  });

  test("placeholder property has String type", () => {
    expect(AcpTextField.elementProperties.get("placeholder")?.type).toBe(String);
  });

  test("disabled property has Boolean type", () => {
    expect(AcpTextField.elementProperties.get("disabled")?.type).toBe(Boolean);
  });

  test("multiline property has Boolean type", () => {
    expect(AcpTextField.elementProperties.get("multiline")?.type).toBe(Boolean);
  });

  test("required property has Boolean type", () => {
    expect(AcpTextField.elementProperties.get("required")?.type).toBe(Boolean);
  });

  test("pattern property has String type", () => {
    expect(AcpTextField.elementProperties.get("pattern")?.type).toBe(String);
  });
});

describe("AcpTextField behavior", () => {
  test("_handleInput dispatches acp-input event with value in detail", () => {
    const instance = new AcpTextField() as AcpTextField & {
      _handleInput(e: Event): void;
    };
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-input", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleInput({ target: { value: "hello" } } as unknown as Event);
    expect(instance.value).toBe("hello");
    expect(events.length).toBe(1);
    expect(events[0].detail).toEqual({ value: "hello" });
  });

  test("_handleChange dispatches acp-change event with value and valid in detail", () => {
    const instance = new AcpTextField() as AcpTextField & {
      _handleChange(e: Event): void;
    };
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleChange({ target: { value: "world" } } as unknown as Event);
    expect(instance.value).toBe("world");
    expect(events.length).toBe(1);
    expect(events[0].detail.value).toBe("world");
    expect(events[0].detail.valid).toBe(true);
  });

  test("_handleChange reports invalid when required field is empty", () => {
    const instance = new AcpTextField() as AcpTextField & {
      _handleChange(e: Event): void;
    };
    instance.required = true;
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleChange({ target: { value: "" } } as unknown as Event);
    expect(events[0].detail.valid).toBe(false);
  });

  test("_handleChange validates against pattern", () => {
    const instance = new AcpTextField() as AcpTextField & {
      _handleChange(e: Event): void;
    };
    instance.pattern = "^[0-9]+$";
    const events: CustomEvent[] = [];
    instance.addEventListener("acp-change", ((e: CustomEvent) => {
      events.push(e);
    }) as EventListener);
    instance._handleChange({ target: { value: "abc" } } as unknown as Event);
    expect(events[0].detail.valid).toBe(false);

    instance._handleChange({ target: { value: "123" } } as unknown as Event);
    expect(events[1].detail.valid).toBe(true);
  });
});
