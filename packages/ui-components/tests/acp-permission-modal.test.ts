import { describe, expect, test } from "bun:test";
import { AcpPermissionModal } from "../src/acp-permission-modal.ts";

describe("AcpPermissionModal", () => {
  test("preserves the selected scope when the same logical request is refreshed", () => {
    const modal = new AcpPermissionModal() as AcpPermissionModal & {
      _selectedScope: string | null;
      updated(changed: Map<PropertyKey, unknown>): void;
    };

    const request = {
      message: "Write file",
      toolCall: {
        title: "Write file",
        rawInput: { path: "/workspace/docs/spec.md" },
      },
      suggestedScopes: [
        { level: "exact", scope: "/workspace/docs/spec.md", label: "Just this file" },
        { level: "parent_dir", scope: "/workspace/docs/", label: "Folder: docs/" },
      ],
    };

    modal.request = request as never;
    modal.updated(new Map([["request", null]]));
    modal._selectedScope = "/workspace/docs/";

    modal.request = {
      ...request,
      suggestedScopes: [...request.suggestedScopes],
    } as never;
    modal.updated(new Map([["request", request]]));

    expect(modal._selectedScope).toBe("/workspace/docs/");
  });

  test("resets _selectedScope when the next request has no suggested scopes", () => {
    const modal = new AcpPermissionModal() as AcpPermissionModal & {
      _selectedScope: string | null;
      updated(changed: Map<PropertyKey, unknown>): void;
    };

    modal.request = {
      suggestedScopes: [{ level: "exact", scope: "/workspace/docs/", label: "Folder: docs/" }],
    } as never;
    modal.updated(new Map([["request", null]]));
    expect(modal._selectedScope).toBe("/workspace/docs/");

    modal.request = null;
    modal.updated(new Map([["request", {}]]));
    expect(modal._selectedScope).toBeNull();
  });

  test("reject forwards the currently selected scope in the event detail", () => {
    const modal = new AcpPermissionModal() as AcpPermissionModal & {
      _selectedScope: string | null;
      _reject(): void;
    };
    modal._selectedScope = "/workspace/docs/";

    const events: Array<Record<string, string | undefined>> = [];
    modal.addEventListener("acp-permission-response", ((
      event: CustomEvent<Record<string, string | undefined>>,
    ) => {
      events.push(event.detail);
    }) as EventListener);

    modal._reject();

    expect(events).toEqual([
      {
        outcome: "cancelled",
        selectedScope: "/workspace/docs/",
      },
    ]);
  });
});

describe("AcpPermissionModal theming contract", () => {
  const stylesText = (
    Array.isArray(AcpPermissionModal.styles)
      ? AcpPermissionModal.styles
      : [AcpPermissionModal.styles]
  )
    .map((s) => String((s as { cssText?: string }).cssText ?? s))
    .join("\n");

  test("declares --acp-modal-* tokens on :host", () => {
    for (const token of [
      "--acp-modal-backdrop-bg",
      "--acp-modal-backdrop-blur",
      "--acp-modal-card-bg",
      "--acp-modal-card-border",
      "--acp-modal-card-radius",
      "--acp-modal-card-padding",
      "--acp-modal-card-max-width",
      "--acp-modal-card-shadow",
    ]) {
      expect(stylesText).toContain(token);
    }
  });

  test("render template exposes the documented shadow parts", () => {
    const modal = new AcpPermissionModal();
    modal.request = {
      message: "Do this?",
      toolCall: {
        title: "workspace.write",
        rawInput: { path: "/tmp/x" },
      },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      suggestedScopes: [
        { level: "exact", scope: "/tmp/x", label: "Just this file" },
        { level: "parent_dir", scope: "/tmp/", label: "Folder: /tmp/" },
      ],
    } as never;

    const flatten = (tpl: unknown): string => {
      const t = tpl as { strings?: readonly string[]; values?: readonly unknown[] };
      let src = (t.strings ?? []).join(" ");
      for (const v of t.values ?? []) {
        if (Array.isArray(v)) {
          for (const inner of v) src += ` ${flatten(inner)}`;
        } else if (v && typeof v === "object" && "strings" in (v as object)) {
          src += ` ${flatten(v)}`;
        } else if (typeof v === "string") {
          src += ` ${v}`;
        }
      }
      return src;
    };
    const src = flatten(modal.render());

    for (const part of [
      'part="card"',
      'part="header"',
      'part="tool-title"',
      'part="message"',
      'part="scope-section"',
      'part="scope-heading"',
      'part="scope-btn"',
      'part="options"',
      'part="footer"',
      'part="btn-reject"',
    ]) {
      expect(src).toContain(part);
    }
  });
});
