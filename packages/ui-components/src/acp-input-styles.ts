import { css } from "lit";

/**
 * Shared CSS for input and label elements used across form components.
 *
 * Provides consistent styling for `<label>`, `<input>`, `<textarea>`,
 * and `<select>` elements including focus, disabled, and error states.
 *
 * Import into component `static styles` arrays alongside `acpTheme`.
 */
export const acpInputStyles = css`
  :host {
    display: block;
  }

  label {
    display: block;
    margin-bottom: 4px;
    font-size: 13px;
    font-weight: 500;
    color: var(--acp-text);
  }

  input,
  textarea,
  select {
    box-sizing: border-box;
    width: 100%;
    padding: 8px 12px;
    border: 1px solid var(--acp-border);
    border-radius: 6px;
    background: var(--acp-bg);
    color: var(--acp-text);
    font-family: inherit;
    font-size: 14px;
    line-height: 1.5;
    outline: none;
    transition: border-color 0.15s;
  }

  input:focus,
  textarea:focus,
  select:focus {
    border-color: var(--acp-accent);
  }

  input:disabled,
  textarea:disabled,
  select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  input.invalid,
  textarea.invalid,
  select.invalid {
    border-color: var(--acp-error);
  }

  .error-text {
    margin-top: 4px;
    font-size: 12px;
    color: var(--acp-error);
  }
`;
