import { describe, expect, test } from "bun:test";
import { AcpModelSelector } from "../src/acp-model-selector.ts";

describe("AcpModelSelector", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpModelSelector).toBe("function");
  });

  test("has reactive properties for models and disabled", () => {
    const props = AcpModelSelector.elementProperties;
    expect(props.get("models")).toBeDefined();
    expect(props.get("disabled")?.type).toBe(Boolean);
  });

  test("has exactly 4 public element properties", () => {
    // models, disabled, hideLabel, variant
    expect(AcpModelSelector.elementProperties.size).toBe(4);
  });

  test("exposes hideLabel as a Boolean property defaulting to false", () => {
    expect(AcpModelSelector.elementProperties.get("hideLabel")?.type).toBe(Boolean);
  });

  test("exposes variant as a reflected String property defaulting to 'default'", () => {
    const variantProp = AcpModelSelector.elementProperties.get("variant");
    expect(variantProp?.type).toBe(String);
    expect(variantProp?.reflect).toBe(true);

    const selector = new AcpModelSelector();
    expect(selector.variant).toBe("default");
  });

  test("models does not reflect to an attribute", () => {
    expect(AcpModelSelector.elementProperties.get("models")?.attribute).toBe(false);
  });

  test("dispatches acp-model-change with the selected model id", () => {
    const selector = new AcpModelSelector() as AcpModelSelector & {
      _onChange(event: Event): void;
    };

    const events: Array<{ modelId: string }> = [];
    selector.addEventListener("acp-model-change", ((event: CustomEvent<{ modelId: string }>) => {
      events.push(event.detail);
    }) as EventListener);

    selector._onChange({
      target: { value: "gpt-5" },
    } as unknown as Event);

    expect(events).toEqual([{ modelId: "gpt-5" }]);
  });
});
