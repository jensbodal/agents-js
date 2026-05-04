import { describe, expect, test } from "bun:test";
import { ACP_CATALOG_ID } from "@agents-js/a2ui-types";
import {
  type A2uiComponentNode,
  A2uiRendererError,
  ACP_BINDINGS,
  renderA2uiComponent,
} from "../src/index.ts";

/** Flatten a TemplateResult's static strings into a single HTML-like string. */
function staticHtml(tpl: { strings: ReadonlyArray<string>; values: unknown[] }): string {
  return tpl.strings.join("<<VALUE>>");
}

const onEvent = () => {};

/**
 * Sample component envelopes — minimally valid so the bindings can unwrap
 * the properties. Each entry maps a component-name to a payload that
 * exercises at least one property.
 */
const samples: Record<string, A2uiComponentNode> = {
  AcpChatApp: { component: "AcpChatApp", transcript: "t", promptInput: "p" },
  AcpTranscript: { component: "AcpTranscript", children: [], autoScroll: true },
  AcpMessage: { component: "AcpMessage", role: "user", body: "hi" },
  AcpStreamingText: { component: "AcpStreamingText", text: "partial" },
  AcpPromptInput: { component: "AcpPromptInput", value: { path: "/input" }, submit: "send" },
  AcpConnectDialog: {
    component: "AcpConnectDialog",
    runtimes: ["local"],
    confirm: "connect",
    cancel: "cancel",
  },
  AcpElicitationForm: {
    component: "AcpElicitationForm",
    children: [],
    submit: "submit",
  },
  AcpPermissionModal: {
    component: "AcpPermissionModal",
    operation: "write file",
    approve: "approve",
    deny: "deny",
  },
  AcpPermissionModeSelector: {
    component: "AcpPermissionModeSelector",
    value: { path: "/mode" },
  },
  AcpWriteGateModal: {
    component: "AcpWriteGateModal",
    path: "/etc/hosts",
    allow: "allow",
    block: "block",
  },
  AcpAuthSelector: {
    component: "AcpAuthSelector",
    methods: ["oauth", "token"],
  },
  AcpModelSelector: {
    component: "AcpModelSelector",
    models: ["sonnet"],
    selected: { path: "/model" },
  },
  AcpDebugPanel: {
    component: "AcpDebugPanel",
    logs: { path: "/logs" },
  },
  AcpStatusBar: { component: "AcpStatusBar", status: "connected" },
  AcpCodeBlock: { component: "AcpCodeBlock", code: "print('hi')", language: "python" },
};

const expectedTags: Record<string, string> = {
  AcpChatApp: "acp-chat-app",
  AcpTranscript: "acp-transcript",
  AcpMessage: "acp-message",
  AcpStreamingText: "acp-streaming-text",
  AcpPromptInput: "acp-prompt-input",
  AcpConnectDialog: "acp-connect-dialog",
  AcpElicitationForm: "acp-elicitation-form",
  AcpPermissionModal: "acp-permission-modal",
  AcpPermissionModeSelector: "acp-permission-mode-selector",
  AcpWriteGateModal: "acp-write-gate-modal",
  AcpAuthSelector: "acp-auth-selector",
  AcpModelSelector: "acp-model-selector",
  AcpDebugPanel: "acp-debug-panel",
  AcpStatusBar: "acp-status-bar",
  AcpCodeBlock: "acp-code-block",
};

describe("renderA2uiComponent dispatch", () => {
  test("ACP_BINDINGS contains all 15 catalog components", () => {
    const keys = Object.keys(ACP_BINDINGS);
    expect(keys).toHaveLength(15);
    for (const name of Object.keys(samples)) {
      expect(ACP_BINDINGS[name]).toBeDefined();
    }
  });

  for (const [name, node] of Object.entries(samples)) {
    test(`routes ${name} to <${expectedTags[name]}>`, () => {
      const tpl = renderA2uiComponent(node, { catalogId: ACP_CATALOG_ID, onEvent });
      expect(tpl).toBeDefined();
      expect(Array.isArray(tpl.strings)).toBe(true);
      const rendered = staticHtml(tpl);
      expect(rendered).toContain(`<${expectedTags[name]}`);
      expect(rendered).toContain(`</${expectedTags[name]}>`);
    });
  }

  test("unknown catalog id throws A2uiRendererError", () => {
    expect(() =>
      renderA2uiComponent(
        { component: "AcpMessage", body: "x" },
        { catalogId: "https://example.invalid/catalog/other/0.1", onEvent },
      ),
    ).toThrow(A2uiRendererError);
  });

  test("unknown component name throws A2uiRendererError", () => {
    expect(() =>
      renderA2uiComponent({ component: "NotAThing" }, { catalogId: ACP_CATALOG_ID, onEvent }),
    ).toThrow(A2uiRendererError);
  });

  test("error carries catalogId + componentName context", () => {
    try {
      renderA2uiComponent({ component: "NotAThing" }, { catalogId: ACP_CATALOG_ID, onEvent });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(A2uiRendererError);
      const e = err as A2uiRendererError;
      expect(e.catalogId).toBe(ACP_CATALOG_ID);
      expect(e.componentName).toBe("NotAThing");
    }
  });

  test("Permission modal routes the single response event to approve OR deny based on outcome", () => {
    // Reviewer's P1: the binding listened for separate
    // acp-permission-approve / acp-permission-deny events that the
    // component never dispatches. The component emits a single
    // `acp-permission-response` event with `detail.outcome` of
    // "selected" (= approve) or "cancelled" (= deny). The fix
    // routes off the actual event using a dual-action wrapper.
    const events: Array<[string, string, Record<string, unknown>]> = [];
    const handler = (surfaceId: string, actionName: string, payload: Record<string, unknown>) => {
      events.push([surfaceId, actionName, payload]);
    };
    const tpl = renderA2uiComponent(
      {
        component: "AcpPermissionModal",
        operation: "write",
        approve: "approve-click",
        deny: "deny-click",
      },
      { catalogId: ACP_CATALOG_ID, onEvent: handler, surfaceId: "s1" },
    );

    const responseListener = tpl.values.find(
      (v): v is (evt: Event) => void => typeof v === "function" && v.length === 1,
    );
    expect(responseListener).toBeDefined();

    // Outcome: selected → approve action.
    responseListener?.(
      new CustomEvent("acp-permission-response", {
        detail: { outcome: "selected", optionId: "allow", selectedScope: "/ws" },
      }),
    );
    expect(events.length).toBe(1);
    expect(events[0]?.[1]).toBe("approve-click");
    expect(events[0]?.[2]).toMatchObject({ outcome: "selected", optionId: "allow" });

    // Outcome: cancelled → deny action.
    responseListener?.(
      new CustomEvent("acp-permission-response", { detail: { outcome: "cancelled" } }),
    );
    expect(events.length).toBe(2);
    expect(events[1]?.[1]).toBe("deny-click");
    expect(events[1]?.[2]).toMatchObject({ outcome: "cancelled" });
  });

  test("Write-gate modal routes acp-write-gate-response by detail.action", () => {
    const events: Array<[string, string, Record<string, unknown>]> = [];
    const handler = (surfaceId: string, actionName: string, payload: Record<string, unknown>) => {
      events.push([surfaceId, actionName, payload]);
    };
    const tpl = renderA2uiComponent(
      {
        component: "AcpWriteGateModal",
        path: "/ws/notes.md",
        rationale: "edit notes",
        allow: "allow-click",
        block: "block-click",
      },
      { catalogId: ACP_CATALOG_ID, onEvent: handler, surfaceId: "s2" },
    );
    const responseListener = tpl.values.find(
      (v): v is (evt: Event) => void => typeof v === "function" && v.length === 1,
    );
    expect(responseListener).toBeDefined();

    responseListener?.(
      new CustomEvent("acp-write-gate-response", { detail: { action: "approve" } }),
    );
    expect(events[0]?.[1]).toBe("allow-click");

    responseListener?.(
      new CustomEvent("acp-write-gate-response", {
        detail: { action: "allow_folder", folder: "/ws" },
      }),
    );
    expect(events[1]?.[1]).toBe("allow-click");
    expect(events[1]?.[2]).toMatchObject({ folder: "/ws" });

    responseListener?.(
      new CustomEvent("acp-write-gate-response", { detail: { action: "reject" } }),
    );
    expect(events[2]?.[1]).toBe("block-click");
  });
});
