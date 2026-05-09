import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Built-in icon paths keyed by name.
 *
 * A small set of commonly needed icons is bundled directly so that
 * `<acp-icon>` works out of the box without an external icon set.
 * Each value is an SVG `<path d="...">` string drawn on a 24×24 viewBox.
 */
const BUILTIN_ICONS: Record<string, string> = {
  close:
    "M18.3 5.71a1 1 0 0 0-1.41 0L12 10.59 7.11 5.7A1 1 0 0 0 5.7 7.11L10.59 12 5.7 16.89a1 1 0 1 0 1.41 1.41L12 13.41l4.89 4.89a1 1 0 0 0 1.41-1.41L13.41 12l4.89-4.89a1 1 0 0 0 0-1.4z",
  check: "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z",
  info: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z",
  warning: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
  error:
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z",
  search:
    "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zM9.5 14C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z",
  settings:
    "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z",
  "chevron-right": "M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
  "chevron-left": "M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z",
  menu: "M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z",
};

/**
 * Icon registry type: a record mapping icon names to SVG path data strings.
 */
export type IconRegistry = Record<string, string>;

/**
 * External icon registries that supplement the built-in icon set.
 *
 * Call `registerIconSet(registry)` to add a custom icon set. When resolving
 * an icon name, external registries are searched first (in registration order),
 * then the built-in map is used as fallback.
 */
const externalRegistries: IconRegistry[] = [];

/**
 * Register an external icon set. Icons from this registry take priority
 * over the built-in set and previously registered sets.
 */
export function registerIconSet(registry: IconRegistry): void {
  externalRegistries.push(registry);
}

/**
 * Clear all registered external icon sets, leaving only the built-in icons.
 */
export function clearIconRegistries(): void {
  externalRegistries.length = 0;
}

/**
 * Resolve an icon name to its SVG path data by searching external registries
 * (in reverse registration order — last registered wins) then falling back
 * to the built-in set.
 */
function resolveIcon(name: string): string | undefined {
  for (let i = externalRegistries.length - 1; i >= 0; i--) {
    const registry = externalRegistries[i];
    if (!registry) continue;
    const path = registry[name];
    if (path) return path;
  }
  return BUILTIN_ICONS[name];
}

/**
 * A themed icon component that renders inline SVG icons.
 *
 * Set `name` to one of the built-in icon identifiers or a name from a
 * registered external icon set. The icon scales according to the `size`
 * property: `"sm"` (16px), `"md"` (24px, default), or `"lg"` (32px).
 * A `color` property overrides the inherited text color.
 *
 * Register custom icon sets via `registerIconSet(registry)`.
 * External registries are searched first (last registered wins),
 * with the built-in set as fallback.
 */
@safeCustomElement("acp-icon")
export class AcpIcon extends LitElement {
  /** Icon name from the built-in set or a registered external set. */
  @property({ type: String })
  accessor name = "";

  /** Display size: "sm" (16px), "md" (24px, default), "lg" (32px). */
  @property({ type: String, reflect: true })
  accessor size: "sm" | "md" | "lg" = "md";

  /** Optional color override. Defaults to `currentColor`. */
  @property({ type: String })
  accessor color = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        vertical-align: middle;
        line-height: 0;
        color: var(--acp-text);
      }

      svg {
        fill: currentColor;
      }

      :host([size="sm"]) svg {
        width: var(--acp-icon-size-sm, 16px);
        height: var(--acp-icon-size-sm, 16px);
      }

      :host([size="md"]) svg,
      svg {
        width: var(--acp-icon-size-md, 24px);
        height: var(--acp-icon-size-md, 24px);
      }

      :host([size="lg"]) svg {
        width: var(--acp-icon-size-lg, 32px);
        height: var(--acp-icon-size-lg, 32px);
      }
    `,
  ];

  protected override render() {
    const pathData = resolveIcon(this.name);
    const colorStyle = this.color ? `color:${this.color}` : "";

    if (!pathData) {
      return nothing;
    }

    return html`
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        style=${colorStyle || nothing}
      >
        <path d=${pathData}></path>
      </svg>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-icon": AcpIcon;
  }
}
