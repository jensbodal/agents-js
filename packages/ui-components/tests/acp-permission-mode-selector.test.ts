import { describe, expect, test } from "bun:test";
import {
  AcpPermissionModeSelector,
  DEFAULT_PERMISSION_MODE_LABELS,
} from "../src/acp-permission-mode-selector.ts";

describe("AcpPermissionModeSelector", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpPermissionModeSelector).toBe("function");
  });

  test("exposes mode and labels reactive properties", () => {
    const props = AcpPermissionModeSelector.elementProperties;
    expect(props.get("mode")?.type).toBe(String);
    expect(props.get("labels")).toBeDefined();
    // labels is an object, not an attribute
    expect(props.get("labels")?.attribute).toBe(false);
  });

  test("has exactly 4 public element properties", () => {
    // mode, labels, hideLabel, variant
    expect(AcpPermissionModeSelector.elementProperties.size).toBe(4);
  });

  test("exposes hideLabel as a Boolean property", () => {
    expect(AcpPermissionModeSelector.elementProperties.get("hideLabel")?.type).toBe(Boolean);
  });

  test("exposes variant as a reflected String property defaulting to 'default'", () => {
    const variantProp = AcpPermissionModeSelector.elementProperties.get("variant");
    expect(variantProp?.type).toBe(String);
    expect(variantProp?.reflect).toBe(true);

    const selector = new AcpPermissionModeSelector();
    expect(selector.variant).toBe("default");
  });

  test("dispatches acp-permission-mode-change with the selected mode", () => {
    const selector = new AcpPermissionModeSelector() as AcpPermissionModeSelector & {
      _onChange(event: Event): void;
    };

    const events: Array<{ mode: string }> = [];
    selector.addEventListener("acp-permission-mode-change", ((
      event: CustomEvent<{ mode: string }>,
    ) => {
      events.push(event.detail);
    }) as EventListener);

    selector._onChange({ target: { value: "bypassPermissions" } } as unknown as Event);

    expect(events).toEqual([{ mode: "bypassPermissions" }]);
  });

  test("labels override falls back to default for missing keys", () => {
    const selector = new AcpPermissionModeSelector() as AcpPermissionModeSelector & {
      _labelFor(value: string): string;
    };

    selector.labels = { default: "Custom Ask" };

    expect(selector._labelFor("default")).toBe("Custom Ask");
    // plan is not overridden — falls back to default
    expect(selector._labelFor("plan")).toBe(DEFAULT_PERMISSION_MODE_LABELS.plan);
    // acceptEdits unchanged
    expect(selector._labelFor("acceptEdits")).toBe(DEFAULT_PERMISSION_MODE_LABELS.acceptEdits);
  });

  test("unknown mode without override returns the mode value itself", () => {
    const selector = new AcpPermissionModeSelector() as AcpPermissionModeSelector & {
      _labelFor(value: string): string;
    };

    expect(selector._labelFor("unknown")).toBe("unknown");
  });

  test("default labels include all four canonical modes", () => {
    expect(DEFAULT_PERMISSION_MODE_LABELS.default).toBe("Ask first");
    expect(DEFAULT_PERMISSION_MODE_LABELS.plan).toBe("Plan first");
    expect(DEFAULT_PERMISSION_MODE_LABELS.acceptEdits).toBe("Auto-approve edits");
    expect(DEFAULT_PERMISSION_MODE_LABELS.bypassPermissions).toBe("Auto-approve all");
  });
});
