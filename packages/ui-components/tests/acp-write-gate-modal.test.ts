import { describe, expect, test } from "bun:test";
import { AcpWriteGateModal } from "../src/acp-write-gate-modal.ts";

describe("AcpWriteGateModal", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpWriteGateModal).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpWriteGateModal.styles).toBeDefined();
    expect(Array.isArray(AcpWriteGateModal.styles)).toBe(true);
  });

  test("exposes path, diff, closestParentFolder as String properties", () => {
    const props = AcpWriteGateModal.elementProperties;
    expect(props.get("path")?.type).toBe(String);
    expect(props.get("diff")?.type).toBe(String);
    expect(props.get("closestParentFolder")?.type).toBe(String);
  });
});

describe("AcpWriteGateModal theming contract", () => {
  const stylesText = (
    Array.isArray(AcpWriteGateModal.styles) ? AcpWriteGateModal.styles : [AcpWriteGateModal.styles]
  )
    .map((s) => String((s as { cssText?: string }).cssText ?? s))
    .join("\n");

  test("declares --acp-modal-* tokens on :host (shared namespace)", () => {
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
    const modal = new AcpWriteGateModal();
    modal.path = "/tmp/hello.txt";
    modal.diff = "+ hello\n- world\n";
    modal.closestParentFolder = "/tmp";

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
    const src = flatten((modal as AcpWriteGateModal & { render(): unknown }).render());

    for (const part of [
      'part="card"',
      'part="header"',
      'part="file-path"',
      'part="diff-area"',
      'part="actions"',
      'part="btn-reject"',
      'part="btn-allow-folder"',
      'part="btn-approve"',
    ]) {
      expect(src).toContain(part);
    }
  });
});
