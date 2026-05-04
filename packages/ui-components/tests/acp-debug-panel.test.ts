import { describe, expect, test } from "bun:test";
import { AcpDebugPanel } from "../src/acp-debug-panel.ts";

describe("AcpDebugPanel", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpDebugPanel).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpDebugPanel.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpDebugPanel.styles)).toBe(true);
  });

  test("has reactive property for state", () => {
    const props = AcpDebugPanel.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("state")).toBeDefined();
  });

  test("state property does not reflect to attribute", () => {
    expect(AcpDebugPanel.elementProperties.get("state")?.attribute).toBe(false);
  });

  test("has reactive property for agentCard", () => {
    expect(AcpDebugPanel.elementProperties.get("agentCard")).toBeDefined();
  });

  test("agentCard property does not reflect to attribute", () => {
    expect(AcpDebugPanel.elementProperties.get("agentCard")?.attribute).toBe(false);
  });

  test("has internal state properties _activeTab, _collapsed", () => {
    const props = AcpDebugPanel.elementProperties;
    expect(props.get("_activeTab")?.state).toBe(true);
    expect(props.get("_collapsed")?.state).toBe(true);
  });

  test("has exactly 4 element properties (2 public + 2 state)", () => {
    expect(AcpDebugPanel.elementProperties.size).toBe(4);
  });

  test("prototype has render method", () => {
    expect(typeof AcpDebugPanel.prototype.render).toBe("function");
  });
});

describe("AcpDebugPanel internal state properties", () => {
  test("prototype has _activeTab accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpDebugPanel.prototype, "_activeTab");
    expect(descriptor).toBeDefined();
  });

  test("prototype has _collapsed accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpDebugPanel.prototype, "_collapsed");
    expect(descriptor).toBeDefined();
  });
});

describe("AcpDebugPanel private methods", () => {
  test("prototype has _toggleCollapse method", () => {
    expect(typeof (AcpDebugPanel.prototype as Record<string, unknown>)._toggleCollapse).toBe(
      "function",
    );
  });

  test("prototype has _setTab method", () => {
    expect(typeof (AcpDebugPanel.prototype as Record<string, unknown>)._setTab).toBe("function");
  });

  test("prototype has _statusClass method", () => {
    expect(typeof (AcpDebugPanel.prototype as Record<string, unknown>)._statusClass).toBe(
      "function",
    );
  });

  test("_statusClass returns correct class for connected", () => {
    const statusClass = (AcpDebugPanel.prototype as Record<string, (...args: unknown[]) => unknown>)
      ._statusClass;
    expect(statusClass.call({}, "connected")).toBe("status-success");
    expect(statusClass.call({}, "completed")).toBe("status-success");
  });

  test("_statusClass returns correct class for error", () => {
    const statusClass = (AcpDebugPanel.prototype as Record<string, (...args: unknown[]) => unknown>)
      ._statusClass;
    expect(statusClass.call({}, "error")).toBe("status-error");
  });

  test("_statusClass returns correct class for active states", () => {
    const statusClass = (AcpDebugPanel.prototype as Record<string, (...args: unknown[]) => unknown>)
      ._statusClass;
    expect(statusClass.call({}, "sending")).toBe("status-active");
    expect(statusClass.call({}, "waiting")).toBe("status-active");
    expect(statusClass.call({}, "connecting")).toBe("status-active");
    expect(statusClass.call({}, "input_required")).toBe("status-active");
  });

  test("_statusClass returns idle class for unknown status", () => {
    const statusClass = (AcpDebugPanel.prototype as Record<string, (...args: unknown[]) => unknown>)
      ._statusClass;
    expect(statusClass.call({}, "idle")).toBe("status-idle");
  });

  test("_statusClass returns empty string for undefined status", () => {
    const statusClass = (AcpDebugPanel.prototype as Record<string, (...args: unknown[]) => unknown>)
      ._statusClass;
    expect(statusClass.call({}, undefined)).toBe("");
  });
});
