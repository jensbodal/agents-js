import { describe, expect, test } from "bun:test";
import { AcpElicitationForm } from "../src/acp-elicitation-form.ts";

describe("AcpElicitationForm", () => {
  test("class exists and is a function", () => {
    expect(typeof AcpElicitationForm).toBe("function");
  });

  test("has expected static styles", () => {
    expect(AcpElicitationForm.styles).toBeDefined();
  });

  test("styles is an array (theme + component styles)", () => {
    expect(Array.isArray(AcpElicitationForm.styles)).toBe(true);
  });

  test("has reactive property for message", () => {
    const props = AcpElicitationForm.elementProperties;
    expect(props).toBeDefined();
    expect(props.get("message")).toBeDefined();
  });

  test("message property has String type", () => {
    expect(AcpElicitationForm.elementProperties.get("message")?.type).toBe(String);
  });

  test("has reactive property for schema", () => {
    expect(AcpElicitationForm.elementProperties.get("schema")).toBeDefined();
  });

  test("schema property does not reflect to attribute", () => {
    expect(AcpElicitationForm.elementProperties.get("schema")?.attribute).toBe(false);
  });

  test("has internal state properties _values, _errors, _fields", () => {
    const props = AcpElicitationForm.elementProperties;
    expect(props.get("_values")).toBeDefined();
    expect(props.get("_values")?.state).toBe(true);
    expect(props.get("_errors")).toBeDefined();
    expect(props.get("_errors")?.state).toBe(true);
    expect(props.get("_fields")).toBeDefined();
    expect(props.get("_fields")?.state).toBe(true);
  });

  test("has exactly 5 element properties (2 public + 3 state)", () => {
    expect(AcpElicitationForm.elementProperties.size).toBe(5);
  });

  test("prototype has render method", () => {
    expect(typeof AcpElicitationForm.prototype.render).toBe("function");
  });

  test("prototype has _validate method", () => {
    expect(typeof (AcpElicitationForm.prototype as Record<string, unknown>)._validate).toBe(
      "function",
    );
  });

  test("prototype has _dispatch method", () => {
    expect(typeof (AcpElicitationForm.prototype as Record<string, unknown>)._dispatch).toBe(
      "function",
    );
  });
});

describe("AcpElicitationForm internal state properties", () => {
  test("prototype has _values accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpElicitationForm.prototype, "_values");
    expect(descriptor).toBeDefined();
  });

  test("prototype has _errors accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpElicitationForm.prototype, "_errors");
    expect(descriptor).toBeDefined();
  });

  test("prototype has _fields accessor", () => {
    const descriptor = Object.getOwnPropertyDescriptor(AcpElicitationForm.prototype, "_fields");
    expect(descriptor).toBeDefined();
  });
});

describe("AcpElicitationForm theming contract", () => {
  const stylesText = (
    Array.isArray(AcpElicitationForm.styles)
      ? AcpElicitationForm.styles
      : [AcpElicitationForm.styles]
  )
    .map((s) => String((s as { cssText?: string }).cssText ?? s))
    .join("\n");

  test("declares --acp-form-* tokens on :host", () => {
    for (const token of [
      "--acp-form-bg",
      "--acp-form-border",
      "--acp-form-radius",
      "--acp-form-padding",
      "--acp-form-max-width",
      "--acp-form-header-color",
      "--acp-form-header-size",
      "--acp-form-title-size",
      "--acp-form-description-size",
    ]) {
      expect(stylesText).toContain(token);
    }
  });

  test("render template exposes the documented action parts", () => {
    const form = new AcpElicitationForm() as AcpElicitationForm & {
      _fields: never[];
      message: string;
    };
    form.message = "Provide details";
    form._fields = [];
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
    const src = flatten((form as AcpElicitationForm & { render(): unknown }).render());
    for (const part of [
      'part="header"',
      'part="actions"',
      'part="btn-accept"',
      'part="btn-decline"',
      'part="btn-cancel"',
    ]) {
      expect(src).toContain(part);
    }
  });

  test("source includes field-level parts (field, field-label, field-input, field-error)", async () => {
    // Source inspection — the render helpers are private so we verify the
    // component source embeds each documented field part.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../src/acp-elicitation-form.ts", import.meta.url),
      "utf8",
    );
    for (const part of [
      'part="field"',
      'part="field-label"',
      'part="field-input"',
      'part="field-error"',
    ]) {
      expect(src).toContain(part);
    }
  });
});
