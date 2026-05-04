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

  test("has exactly 5 public element properties", () => {
    // mode, labels, hideLabel, compact (deprecated), variant
    expect(AcpPermissionModeSelector.elementProperties.size).toBe(5);
  });

  test("exposes hideLabel + compact as Boolean properties", () => {
    expect(AcpPermissionModeSelector.elementProperties.get("hideLabel")?.type).toBe(Boolean);
    expect(AcpPermissionModeSelector.elementProperties.get("compact")?.type).toBe(Boolean);
  });

  test("exposes variant as a reflected String property defaulting to 'default'", () => {
    const variantProp = AcpPermissionModeSelector.elementProperties.get("variant");
    expect(variantProp?.type).toBe(String);
    expect(variantProp?.reflect).toBe(true);

    const selector = new AcpPermissionModeSelector();
    expect(selector.variant).toBe("default");
  });

  test("deprecated `compact=true` aliases to variant='embedded' via willUpdate", () => {
    const selector = new AcpPermissionModeSelector() as AcpPermissionModeSelector & {
      willUpdate(changed: Map<string, unknown>): void;
    };
    expect(selector.variant).toBe("default");
    selector.compact = true;
    // Simulate Lit's lifecycle: call willUpdate with a changed map reflecting
    // the compact transition. We can't depend on the async update cycle in a
    // pure-unit test, so invoke the (protected) lifecycle hook directly.
    selector.willUpdate(new Map([["compact", false]]));
    expect(selector.variant).toBe("embedded");
  });

  test("setting variant='embedded' directly does not flip compact back", () => {
    const selector = new AcpPermissionModeSelector();
    selector.variant = "embedded";
    // variant→compact projection is intentionally one-way; compact stays false.
    expect(selector.compact).toBe(false);
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

    selector._onChange({ target: { value: "yolo" } } as unknown as Event);

    expect(events).toEqual([{ mode: "yolo" }]);
  });

  test("labels override falls back to default for missing keys", () => {
    const selector = new AcpPermissionModeSelector() as AcpPermissionModeSelector & {
      _labelFor(value: string): string;
    };

    selector.labels = { ask: "Custom Ask" };

    expect(selector._labelFor("ask")).toBe("Custom Ask");
    // plan is not overridden — falls back to default
    expect(selector._labelFor("plan")).toBe(DEFAULT_PERMISSION_MODE_LABELS.plan);
    // hub unchanged
    expect(selector._labelFor("hub")).toBe(DEFAULT_PERMISSION_MODE_LABELS.hub);
  });

  test("unknown mode without override returns the mode value itself", () => {
    const selector = new AcpPermissionModeSelector() as AcpPermissionModeSelector & {
      _labelFor(value: string): string;
    };

    expect(selector._labelFor("unknown")).toBe("unknown");
  });

  test("default labels include all four canonical modes", () => {
    expect(DEFAULT_PERMISSION_MODE_LABELS.ask).toBe("Ask first");
    expect(DEFAULT_PERMISSION_MODE_LABELS.plan).toBe("Plan first");
    expect(DEFAULT_PERMISSION_MODE_LABELS.hub).toBe("Workspace hub");
    expect(DEFAULT_PERMISSION_MODE_LABELS.yolo).toBe("Auto-approve writes");
  });
});
