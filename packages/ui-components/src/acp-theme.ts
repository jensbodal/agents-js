import { css } from "lit";

/**
 * Shared Tokyo Night theme as CSS custom properties.
 *
 * Each property uses a double-var pattern: the component references
 * `var(--acp-bg, #0f1117)` as the compiled default, but hosts can set
 * `--acp-bg` on the document or a parent element to override.
 *
 * Import this shared Lit style template and spread it into your component's
 * `static override styles` array.
 */
export const acpTheme = css`
  :host {
    --acp-bg: var(--acp-color-bg, #0f1117);
    --acp-bg-secondary: var(--acp-color-bg-secondary, #1a1b26);
    --acp-bg-tertiary: var(--acp-color-bg-tertiary, #24283b);
    --acp-border: var(--acp-color-border, #414868);
    --acp-text: var(--acp-color-text, #c0caf5);
    --acp-text-muted: var(--acp-color-text-muted, #565f89);
    --acp-accent: var(--acp-color-accent, #7aa2f7);
    --acp-accent-purple: var(--acp-color-accent-purple, #bb9af7);
    --acp-accent-gold: var(--acp-color-accent-gold, #e0af68);
    --acp-success: var(--acp-color-success, #9ece6a);
    --acp-error: var(--acp-color-error, #f7768e);
    font-family: var(--acp-font, system-ui, -apple-system, sans-serif);
  }
`;
