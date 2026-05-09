import { type FieldMeta, type SchemaProperty, toFieldMetas } from "@agents-js/schema-utils";
import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { acpInputStyles } from "./acp-input-styles.ts";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Shape of the schema prop — matches ACPA2AElicitationSchema from a2a-client.
 */
interface ElicitationSchema {
  title?: string | null;
  description?: string | null;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

type ContentValue = string | number | boolean | string[];

/**
 * An elicitation form component that renders schema-driven fields with
 * Accept / Decline / Cancel actions.
 *
 * Dispatches `acp-elicitation-response` CustomEvent on user action.
 *
 * ## Theming
 *
 * Modal-class component: primary mechanism is P2 shadow parts; P1 tokens
 * handle color + spacing overrides.
 *
 * Tokens (default to pre-tokenization hardcoded values and the global
 * `--acp-*` palette):
 * - `--acp-form-bg`, `--acp-form-border`, `--acp-form-radius`,
 *   `--acp-form-padding`, `--acp-form-max-width`
 * - `--acp-form-header-color`, `--acp-form-header-size`,
 *   `--acp-form-title-size`, `--acp-form-description-size`
 *
 * Parts:
 * - `part="header"` — the `.form-header` message banner.
 * - `part="title"` — the `<h3>` schema title.
 * - `part="description"` — the schema description paragraph.
 * - `part="field"` — the per-field wrapper.
 * - `part="field-label"` — the `<label>` element.
 * - `part="field-input"` — the input / select / textarea element.
 * - `part="field-error"` — the per-field error message.
 * - `part="actions"` — the footer action row.
 * - `part="btn-accept"` / `part="btn-decline"` / `part="btn-cancel"` —
 *   individual action buttons.
 */
@safeCustomElement("acp-elicitation-form")
export class AcpElicitationForm extends LitElement {
  @property({ type: String })
  accessor message = "";

  @property({ attribute: false })
  accessor schema: ElicitationSchema = {};

  @state()
  accessor _values: Record<string, string> = {};

  @state()
  accessor _errors: Record<string, string> = {};

  @state()
  accessor _fields: FieldMeta[] = [];

  static override styles = [
    acpTheme,
    acpInputStyles,
    css`
      :host {
        /* Per-component tokens (P1). Defaults preserve pre-tokenization
         * visuals. Hosts can override at :root, a parent element, or the
         * host itself to retheme the form. */
        --acp-form-bg: var(--acp-bg-secondary);
        --acp-form-border: var(--acp-border);
        --acp-form-radius: 8px;
        --acp-form-padding: 20px;
        --acp-form-max-width: 560px;
        --acp-form-header-color: var(--acp-accent);
        --acp-form-header-size: 15px;
        --acp-form-title-size: 17px;
        --acp-form-description-size: 13px;

        background: var(--acp-form-bg);
        border: 1px solid var(--acp-form-border);
        border-radius: var(--acp-form-radius);
        padding: var(--acp-form-padding);
        color: var(--acp-text);
        max-width: var(--acp-form-max-width);
      }

      .form-header {
        margin: 0 0 16px;
        font-size: var(--acp-form-header-size);
        font-weight: 600;
        color: var(--acp-form-header-color);
        line-height: 1.4;
      }

      .form-title {
        margin: 0 0 4px;
        font-size: var(--acp-form-title-size);
        font-weight: 700;
        color: var(--acp-text);
      }

      .form-description {
        margin: 0 0 16px;
        font-size: var(--acp-form-description-size);
        color: var(--acp-text-muted);
        line-height: 1.4;
      }

      .field {
        margin-bottom: 14px;
      }

      .required-mark {
        color: var(--acp-error);
        margin-left: 2px;
      }

      .field-description {
        font-size: 11px;
        color: var(--acp-text-muted);
        margin-bottom: 4px;
      }

      input[type="text"],
      input[type="number"] {
        padding: 8px 10px;
        border-radius: 4px;
        font-size: 13px;
      }

      select {
        padding: 8px 10px;
        border-radius: 4px;
        font-size: 13px;
      }

      input.has-error,
      select.has-error {
        border-color: var(--acp-error);
      }

      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .checkbox-row input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: var(--acp-accent);
        cursor: pointer;
      }

      .checkbox-row label {
        margin-bottom: 0;
        cursor: pointer;
      }

      .error-text {
        font-size: 11px;
        margin-top: 3px;
      }

      .actions {
        display: flex;
        gap: 8px;
        margin-top: 20px;
        padding-top: 16px;
        border-top: 1px solid var(--acp-border);
      }

      button {
        padding: 8px 18px;
        border: 1px solid var(--acp-border);
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }

      .btn-accept {
        background: var(--acp-accent);
        color: var(--acp-bg);
        border-color: var(--acp-accent);
      }
      .btn-accept:hover {
        filter: brightness(1.1);
      }

      .btn-decline {
        background: transparent;
        color: var(--acp-accent-gold);
        border-color: var(--acp-accent-gold);
      }
      .btn-decline:hover {
        background: color-mix(in srgb, var(--acp-accent-gold) 10%, transparent);
      }

      .btn-cancel {
        background: transparent;
        color: var(--acp-text-muted);
        border-color: var(--acp-border);
      }
      .btn-cancel:hover {
        background: color-mix(in srgb, var(--acp-text-muted) 10%, transparent);
      }
    `,
  ];

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("schema")) {
      this._fields = toFieldMetas(this.schema);
      // Reset form state when schema changes
      this._values = {};
      this._errors = {};
    }
  }

  private _onInputChange(fieldName: string, value: string): void {
    this._values = { ...this._values, [fieldName]: value };
    // Clear error for this field on edit
    if (this._errors[fieldName]) {
      const next = { ...this._errors };
      delete next[fieldName];
      this._errors = next;
    }
  }

  private _onCheckboxChange(fieldName: string, checked: boolean): void {
    this._values = { ...this._values, [fieldName]: checked ? "true" : "false" };
  }

  private _validate(): Record<string, ContentValue> | null {
    const errors: Record<string, string> = {};
    const content: Record<string, ContentValue> = {};

    for (const field of this._fields) {
      const raw = (this._values[field.name] ?? "").trim();

      if (!raw && field.required) {
        errors[field.name] = `${field.title ?? field.name} is required`;
        continue;
      }

      if (!raw) {
        continue;
      }

      if (field.type === "boolean") {
        const lower = raw.toLowerCase();
        if (["true", "t", "yes", "y", "1"].includes(lower)) {
          content[field.name] = true;
        } else if (["false", "f", "no", "n", "0"].includes(lower)) {
          content[field.name] = false;
        } else {
          errors[field.name] = "Enter true/false, yes/no, or 1/0";
        }
        continue;
      }

      if (field.type === "integer") {
        const num = Number.parseInt(raw, 10);
        if (Number.isNaN(num)) {
          errors[field.name] = "Enter a valid integer";
        } else {
          content[field.name] = num;
        }
        continue;
      }

      if (field.type === "number") {
        const num = Number.parseFloat(raw);
        if (Number.isNaN(num)) {
          errors[field.name] = "Enter a valid number";
        } else {
          content[field.name] = num;
        }
        continue;
      }

      if (field.type === "array") {
        const values = raw
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        if (field.required && values.length === 0) {
          errors[field.name] = "At least one value is required";
        } else if (field.enumValues && values.some((v) => !field.enumValues?.includes(v))) {
          errors[field.name] = `Must use: ${field.enumValues.join(", ")}`;
        } else {
          content[field.name] = values;
        }
        continue;
      }

      // string
      if (field.enumValues && !field.enumValues.includes(raw)) {
        errors[field.name] = `Must be one of: ${field.enumValues.join(", ")}`;
      } else {
        content[field.name] = raw;
      }
    }

    if (Object.keys(errors).length > 0) {
      this._errors = errors;
      return null;
    }

    return content;
  }

  private _dispatch(action: "accept" | "decline" | "cancel"): void {
    if (action === "accept") {
      const content = this._validate();
      if (!content) return;
      this.dispatchEvent(
        new CustomEvent("acp-elicitation-response", {
          bubbles: true,
          composed: true,
          detail: { action: "accept", content },
        }),
      );
    } else {
      this.dispatchEvent(
        new CustomEvent("acp-elicitation-response", {
          bubbles: true,
          composed: true,
          detail: { action },
        }),
      );
    }
  }

  private _fieldWrapper(field: FieldMeta, input: unknown, extra?: unknown) {
    const label = field.title ?? field.name;
    const error = this._errors[field.name];
    return html`
      <div part="field" class="field">
        <label part="field-label" for=${field.name}>
          ${label}
          ${field.required ? html`<span class="required-mark">*</span>` : nothing}
        </label>
        ${field.description ? html`<div class="field-description">${field.description}</div>` : nothing}
        ${input}
        ${extra ?? nothing}
        ${error ? html`<div part="field-error" class="error-text">${error}</div>` : nothing}
      </div>
    `;
  }

  private _renderField(field: FieldMeta) {
    const error = this._errors[field.name];
    const errorClass = error ? "has-error" : "";
    const onInput = (e: { target: { value: string } }) =>
      this._onInputChange(field.name, e.target.value);

    // Boolean -> checkbox (unique layout: label inside checkbox-row)
    if (field.type === "boolean") {
      const label = field.title ?? field.name;
      const checked = this._values[field.name] === "true";
      return html`
        <div part="field" class="field">
          <div class="checkbox-row">
            <input
              part="field-input"
              type="checkbox"
              id=${field.name}
              .checked=${checked}
              @change=${(e: { target: { checked: boolean } }) =>
                this._onCheckboxChange(field.name, e.target.checked)}
            />
            <label part="field-label" for=${field.name}>
              ${label}
              ${field.required ? html`<span class="required-mark">*</span>` : nothing}
            </label>
          </div>
          ${field.description ? html`<div class="field-description">${field.description}</div>` : nothing}
          ${error ? html`<div part="field-error" class="error-text">${error}</div>` : nothing}
        </div>
      `;
    }

    // Enum / oneOf -> select dropdown
    if (field.enumValues && field.enumValues.length > 0) {
      return this._fieldWrapper(
        field,
        html`<select
          part="field-input"
          id=${field.name}
          class=${errorClass}
          @change=${(e: { target: { value: string } }) => onInput(e)}
        >
          <option value="">-- select --</option>
          ${field.enumValues.map(
            (val) => html`
              <option value=${val} ?selected=${this._values[field.name] === val}>
                ${field.oneOfTitles?.[val] ? `${val} (${field.oneOfTitles[val]})` : val}
              </option>
            `,
          )}
        </select>`,
      );
    }

    // Number / integer -> number input
    if (field.type === "number" || field.type === "integer") {
      return this._fieldWrapper(
        field,
        html`<input
          part="field-input"
          type="number"
          id=${field.name}
          class=${errorClass}
          .value=${this._values[field.name] ?? ""}
          ?step=${field.type === "integer" ? 1 : undefined}
          @input=${onInput}
        />`,
      );
    }

    // Array -> text input (comma-separated) with optional enum hint
    if (field.type === "array") {
      return this._fieldWrapper(
        field,
        html`<input
          part="field-input"
          type="text"
          id=${field.name}
          class=${errorClass}
          placeholder="comma-separated values"
          .value=${this._values[field.name] ?? ""}
          @input=${onInput}
        />`,
        field.enumValues
          ? html`<div class="field-description">Options: ${field.enumValues.join(", ")}</div>`
          : nothing,
      );
    }

    // Default: string -> text input
    return this._fieldWrapper(
      field,
      html`<input
        part="field-input"
        type="text"
        id=${field.name}
        class=${errorClass}
        .value=${this._values[field.name] ?? ""}
        @input=${onInput}
      />`,
    );
  }

  protected override render() {
    const schemaTitle = this.schema.title;
    const schemaDescription = this.schema.description;

    return html`
      ${this.message ? html`<div part="header" class="form-header">${this.message}</div>` : nothing}
      ${schemaTitle ? html`<h3 part="title" class="form-title">${schemaTitle}</h3>` : nothing}
      ${schemaDescription ? html`<p part="description" class="form-description">${schemaDescription}</p>` : nothing}

      ${this._fields.map((field) => this._renderField(field))}

      <div part="actions" class="actions">
        <button part="btn-accept" class="btn-accept" @click=${() => this._dispatch("accept")}>Accept</button>
        <button part="btn-decline" class="btn-decline" @click=${() => this._dispatch("decline")}>Decline</button>
        <button part="btn-cancel" class="btn-cancel" @click=${() => this._dispatch("cancel")}>Cancel</button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-elicitation-form": AcpElicitationForm;
  }
}
