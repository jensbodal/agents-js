# UI Components Theming Contract

**Status**: Design proposal, pre-implementation
**Owner**: `@agents-js/ui-components`
**Driving consumer**: `obsidian-acp-plugin` status bar (AGENT / MODE / MODEL row)
**Scope**: All ~30 Lit custom elements in `packages/ui-components/src/`
**Date**: 2026-04-17

---

## 0. Problem statement

`@agents-js/ui-components` ships Lit custom elements whose rendering lives inside a shadow DOM. The shadow boundary protects the components' internal markup and styling from accidental host CSS collisions — a feature we want to keep. But it also blocks hosts from _intentionally_ aligning SDK component chrome with their own visual language.

A concrete, now-shipping, example: the obsidian-acp-plugin status bar renders three selectors side by side inside a plugin-owned `.acp-status-controls` row:

- `<select class="acp-agent-select">` — plugin-owned, raw DOM, styled with `border-color: var(--color-orange, ...)` and the plugin's box framing.
- `<acp-permission-mode-selector>` — SDK custom element.
- `<acp-model-selector>` — SDK custom element.

The plugin writes CSS like `.acp-permission-mode-select[data-mode="ask"] { border-color: var(--color-green); }` hoping to color-code the mode chip. That CSS reaches the _host element_ — but the actual `<select>` renders inside the shadow root with `background: var(--acp-bg-secondary); border: 1px solid var(--acp-border);` coming from the shared `acpTheme` CSS variables. The host CSS never takes effect on the control the user sees. Result: visual drift between the plugin's AGENT box and the two SDK selectors.

We landed two one-off props on `acp-permission-mode-selector` (`hideLabel`, `compact`) to address label duplication and standalone-toolbar chrome for that one component. That unblocks 80% of the Obsidian case but does not generalize — the next host with the same problem will need another set of props, and `acp-model-selector` already needs `compact` for the same reasons.

This doc proposes a unified theming contract for the package.

---

## 1. Current state survey

### Shared infrastructure

**`acp-theme.ts`** — Single source of theme tokens. Already uses a double-var pattern: `--acp-bg: var(--acp-color-bg, #0f1117)`. Hosts can set `--acp-color-bg` on an ancestor and it cascades through the shadow boundary via CSS custom property inheritance. **Token palette**: `--acp-bg`, `--acp-bg-secondary`, `--acp-bg-tertiary`, `--acp-border`, `--acp-text`, `--acp-text-muted`, `--acp-accent`, `--acp-accent-purple`, `--acp-accent-gold`, `--acp-success`, `--acp-error`, `--acp-font`. Plus `--acp-font-mono` referenced directly by some components.

**`acp-input-styles.ts`** — Shared styles for `<label>`, `<input>`, `<textarea>`, `<select>` (padding 8px 12px, border-radius 6px, border 1px solid `var(--acp-border)`, etc.). Used by `acp-text-field`, `acp-elicitation-form`, `acp-date-time-input`. Components that use _compact_ controls (the selectors) bypass this and inline their own smaller padding/border-radius.

**`::part()` inventory**: zero matches across the package (`grep part=` returns nothing). No component exposes shadow parts today.

### Per-component detail (most-used first)

| # | Component | Role | `acpTheme` tokens consumed | Hardcoded non-token values | Exposes `::part`? | Consumers |
|---|-----------|------|---------------------------|----------------------------|-------------------|-----------|
| 1 | `acp-button` | Inline control | `--acp-accent`, `--acp-accent-purple`, `--acp-bg`, `--acp-text`, `--acp-bg-tertiary`, `--acp-border`, `--acp-error` | border-radius `6px`, font-weight `600`, size-{sm,md,lg} padding trios, spinner size `1em`, transition `0.15s` | No | web-ui, obsidian (indirect via `acp-elicitation-form`) |
| 2 | `acp-permission-mode-selector` | Inline control | `--acp-bg-secondary`, `--acp-border`, `--acp-text-muted`, `--acp-text`, `--acp-accent` | label font-size `11px` + uppercase, select padding `3px 8px`, border-radius `4px`, select font-size `12px`. `:host` padding `4px 16px` + bg/border-bottom (toggleable via `compact` attr — **one-off today**). | No | web-ui, obsidian (`src/ui/status-bar.ts`) |
| 3 | `acp-model-selector` | Inline control | `--acp-bg-secondary`, `--acp-border`, `--acp-text`, `--acp-accent`, `--acp-text-muted` | Same font + padding recipe as above, `min-width: 180px`. **Already has `hideLabel` but no `compact` yet.** | No | web-ui, obsidian |
| 4 | `acp-text-field` | Inline control | `acpInputStyles` (all tokens) | min-height `80px` for textarea. Otherwise delegates to `acpInputStyles`. | No | web-ui, `acp-elicitation-form` |
| 5 | `acp-status-bar` | Composite | `--acp-bg-secondary`, `--acp-border`, `--acp-text`, `--acp-text-muted`, `--acp-success`, `--acp-accent`, `--acp-error`, `--acp-font-mono` | `:host` padding `8px 16px`, badge padding `2px 10px` + `9999px` radius, dot `6px`. The entire surface shape. | No | web-ui. Obsidian replaces entirely. |
| 6 | `acp-permission-modal` | Modal | `--acp-bg-secondary`, `--acp-border`, `--acp-text`, `--acp-text-muted`, `--acp-accent`, `--acp-error`, `--acp-font-mono` | backdrop `rgba(0,0,0,0.6)` + `blur(4px)`, card padding `24px 28px`, border-radius `12px`, max-width `500px`, shadow `0 8px 32px rgba(0,0,0,0.4)`. Allow/Deny/Reject button variants hardcoded. | No | web-ui. Obsidian has _its own_ `src/ui/permission-modal.ts` because SDK modal isn't tunable. |
| 7 | `acp-modal` | Modal | `--acp-bg-secondary`, `--acp-border`, `--acp-text`, `--acp-text-muted`, `--acp-bg-tertiary` | backdrop rgba hardcoded, dialog radius `12px`, close button `28x28`, animations. | No | web-ui (base for custom dialogs) |
| 8 | `acp-elicitation-form` | Composite (form + modal-ish) | `acpInputStyles` + `--acp-accent`, `--acp-text`, `--acp-text-muted`, `--acp-error`, `--acp-bg-secondary`, `--acp-border` | `:host` padding `20px`, border-radius `8px`, form-header `15px`/`600`, form-title `17px`/`700`, field-description `11px`. | No | web-ui, obsidian (has its own wrapper `src/ui/elicitation-modal.ts`) |
| 9 | `acp-message` | Text-level | `--acp-text`, `--acp-bg-tertiary`, `--acp-bg-secondary`, `--acp-success`, `--acp-accent`, `--acp-accent-purple`, `--acp-border`, `--acp-text-muted`, `--acp-font-mono` | bubble border-radius `12px` + asymmetric `4px` corner, max-width `85%`, padding `10px 14px`, font-size `14px`, line-height `1.6`. Role label `11px` uppercase. | No | web-ui, obsidian (rendered by `acp-transcript`) |
| 10 | `acp-chat-app` | Top-level composite | All tokens (transitively) | Layout shell: flex column, prompt input + transcript + overlay stack. Relies on child components for everything visual. | No | web-ui only. Obsidian does NOT use `acp-chat-app` — it composes session UI itself. |

### Long-tail summary (the remaining ~20 components)

- **Text/display** (`acp-streaming-text`, `acp-code-block`, `acp-transcript`, `acp-plan-panel`, `acp-debug-panel`, `acp-icon`, `acp-image`, `acp-divider`, `acp-row`, `acp-column`): consume tokens; hardcode layout metrics (padding/gap/radii). `acp-code-block` is the outlier — it uses Obsidian-style token names (`--background-modifier-border`, `--text-muted`, `--font-monospace`) directly instead of `acpTheme`, so it's already host-themable by accident on Obsidian but broken on non-Obsidian hosts. Flag this as a consistency bug.
- **Form controls** (`acp-checkbox`, `acp-slider`, `acp-choice-picker`, `acp-date-time-input`): consume tokens; hardcode checkbox size (`18px`), slider track dims, choice radio chip radii.
- **Overlays** (`acp-write-gate-modal`, `acp-overlay-stack`, `acp-connect-dialog`, `acp-auth-selector`): same modal shape language as `acp-permission-modal`.
- **Primitives** (`acp-prompt-input`, `acp-status-bar` addressed above).

---

## 2. Gap analysis — four classes of gap

The survey makes clear that there is no single "theming gap" — there are four distinct ones that want different contract shapes.

### Class A — Control-level styling (inline controls)

**Components**: `acp-button`, `acp-permission-mode-selector`, `acp-model-selector`, `acp-text-field`, `acp-checkbox`, `acp-slider`, `acp-date-time-input`, `acp-choice-picker`, `acp-auth-selector`.

**What hosts want**: align the control's border/padding/radius/font-size with the host's existing form controls, and color-code by state (e.g. the plugin's `data-mode="ask"` green border). Essentially: host wants to paint the one visible `<select>` / `<button>` / `<input>` inside the shadow root.

**Why existing token cascade is not enough**: tokens like `--acp-border` are shared across many components. Overriding `--acp-border` on the plugin's `.acp-status-controls` wrapper repaints every SDK component inside, which (a) over-reaches and (b) still can't touch the hardcoded padding/radius/font-size values that are NOT behind tokens today.

### Class B — Modal-level styling

**Components**: `acp-permission-modal`, `acp-modal`, `acp-write-gate-modal`, `acp-connect-dialog`, `acp-elicitation-form`.

**What hosts want**: replace the backdrop, card radius, card padding, and Allow/Deny/Reject button shape with the host's modal idiom. For Obsidian, the SDK modal doesn't composite correctly with Obsidian's own modal layer (z-index, focus, Escape handling all owned by Obsidian's Modal class). This is why obsidian-acp-plugin re-implements the permission modal entirely — the SDK modal isn't tunable at the _shape_ level.

**Signal**: the existence of `src/ui/permission-modal.ts` in obsidian-acp-plugin. A tunable SDK modal would delete that file.

### Class C — Text-level styling

**Components**: `acp-message`, `acp-streaming-text`, `acp-code-block`, `acp-transcript`.

**What hosts want**: per-role bubble styling (user/agent colors, background, asymmetric radius), code-block framing. Less urgent — most hosts accept the SDK look here and these are already mostly-themed via `acpTheme` tokens. Main gap: bubble `max-width: 85%` hardcoded, bubble border-radius hardcoded, role label typography hardcoded. `acp-code-block` uses the wrong token namespace (Obsidian-specific).

### Class D — Composite styling

**Components**: `acp-status-bar`, `acp-chat-app`, `acp-debug-panel`, `acp-plan-panel`.

**What hosts want**: replace whole sections with host-owned markup. Obsidian already does this for the status bar — it doesn't use `acp-status-bar` at all; it builds its own from raw DOM because the SDK version is too opinionated about layout. This is the slot/composition gap.

**Signal**: obsidian has `src/ui/status-bar.ts` and does not consume `<acp-status-bar>`.

---

## 3. Proposed theming contract

No single universal pattern fits all four gap classes. Recommended shape: **per-class contract, chosen from a short menu of four primitives.**

### Pattern menu

**P1. Scoped CSS custom properties on `:host` (control-level tokens)**

Declare per-component scoped tokens that default to the existing global `--acp-*` tokens. Example:

```css
:host {
  --acp-select-border: var(--acp-border);
  --acp-select-padding: 3px 8px;
  --acp-select-radius: 4px;
  --acp-select-font-size: 12px;
  --acp-select-bg: var(--acp-bg-secondary);
}
select {
  border: 1px solid var(--acp-select-border);
  padding: var(--acp-select-padding);
  border-radius: var(--acp-select-radius);
  font-size: var(--acp-select-font-size);
  background: var(--acp-select-bg);
}
```

Hosts set `--acp-select-border: var(--color-orange)` on the parent wrapper and only the inner select is affected. Cascades through shadow DOM via CSS custom property inheritance (standardized, supported in Electron 22+, which covers Obsidian 1.4+).

- Fits: Class A (control-level).
- Doesn't fit: Class B/C/D — too many moving parts to express in tokens alone.
- Tradeoff: verbose token list per component. But this is authored once and adds ~6–10 tokens per control.
- Migration: additive, zero breakage.

**P2. `::part()` attributes on inner elements (modal-level shape)**

Tag the important inner elements with `part="..."` so hosts can target them from outside the shadow root:

```html
<!-- inside acp-permission-modal shadow DOM -->
<div class="backdrop" part="backdrop">
  <div class="card" part="card">
    <h2 part="header">Confirm Access</h2>
    <button part="btn-allow" ...>...</button>
  </div>
</div>
```

Host CSS:
```css
acp-permission-modal::part(card) {
  padding: var(--plugin-modal-padding);
  border-radius: var(--plugin-modal-radius);
}
```

- Fits: Class B (modal shape tuning), also useful for Class A at a more granular tier.
- Doesn't fit: Class D — `::part()` can't let a host swap out whole regions.
- Tradeoff: `::part()` cannot inherit — hosts must redeclare for each component. Specificity is well-defined (similar to a class selector). Supported in Electron ≥85 (Obsidian ships Electron 28+, fine).
- Migration: additive. Add `part=` attributes to existing elements; they're invisible until a host targets them.

**P3. Boolean variant / preset props (coarse mode switches)**

Boolean props that flip `:host` into a different visual mode. What we shipped on `acp-permission-mode-selector` (`hideLabel`, `compact`).

- Fits: Class A as a quick preset layer _on top of_ P1 tokens. Good for "I want the embed-into-host-toolbar preset" as a single flag instead of six token overrides.
- Doesn't fit: anywhere as a _primary_ mechanism — presets calcify the API.
- Tradeoff: simple, discoverable, strongly typed. But proliferation risk (each new host-specific need becomes a new boolean).
- Migration: additive.

**P4. Slots for host-provided regions (composite replacement)**

Named slots let hosts inject their own markup for whole sub-regions:

```html
<!-- acp-status-bar -->
<slot name="leading">
  <span class="agent-name">${agentName}</span>
</slot>
<slot name="badge"><!-- default badge --></slot>
<slot name="trailing"><!-- default session id --></slot>
```

- Fits: Class D (composite-level replacement).
- Tradeoff: most flexible. Requires the component to be designed around insertion points — a one-time rewrite per composite.
- Migration: needs care. Adding a `<slot>` with a default child is backwards-compatible; hosts opt in by providing slotted content.

### Recommended contract per class

| Gap class | Primary | Secondary | Rationale |
|-----------|---------|-----------|-----------|
| **A. Control-level** | **P1 scoped tokens** | P3 presets for common combos (`compact`, `dense`), P2 parts for the inner control | Tokens handle the 90% case (paint/spacing). One `compact` preset covers toolbar embedding. `::part()` is escape-hatch for per-state styling (e.g., invalid state border-color) where tokens are insufficient. |
| **B. Modal-level** | **P2 parts** + P1 tokens | — | Modals have identifiable regions (backdrop, card, header, footer, button-primary, button-danger). Parts let hosts tune shape without API churn. Keep P1 tokens for color-only overrides. |
| **C. Text-level** | **P1 scoped tokens** | P2 parts on bubble + role label | Start with tokens. Fix `acp-code-block` Obsidian-token leak by adding `--acp-code-block-border` that defaults to `--acp-border`. Parts on `bubble`/`copy-btn` as escape-hatch. |
| **D. Composite** | **P4 slots** | P1 tokens for fallback colors | Hosts that use the composite at all want to replace sections. Obsidian today _doesn't_ use `acp-status-bar` because it can't. Named slots (`leading`, `trailing`, `badge`, `controls`) make adoption possible. |

### Token naming convention (for P1 adoption)

Scope tokens under a component-level prefix so overrides don't leak across components:

- Global: `--acp-*` (existing theme palette — unchanged).
- Per-component: `--acp-<component>-<property>`, e.g. `--acp-select-border`, `--acp-button-radius`, `--acp-modal-card-padding`.

Each per-component token defaults to the corresponding global token (`--acp-select-border: var(--acp-border)`). Hosts can override at whichever layer they want:
- Global: `--acp-border` (repaints everything).
- Component-wide: `--acp-select-border` on `:root` or a parent (repaints all selects).
- Instance: `--acp-select-border` on a specific component (repaints one).

---

## 4. Per-component API spec (priority set)

### `acp-button`

**Tokens (P1)**:
- `--acp-button-radius` → `var(--acp-border-radius, 6px)` (new global `--acp-border-radius`)
- `--acp-button-padding-sm|md|lg` → hardcoded size presets
- `--acp-button-font-weight` → `600`
- `--acp-button-bg-primary|secondary|danger|ghost` → existing palette vars
- `--acp-button-border-primary|secondary|danger|ghost`
- `--acp-button-color-primary|secondary|danger|ghost`
- `--acp-button-transition` → `background 0.15s, border-color 0.15s, opacity 0.15s`

**Parts (P2)**:
- `part="button"` on the inner `<button>` element.
- `part="spinner"` on the loading spinner.

**New props**: none. Existing `variant`, `size`, `disabled`, `loading`, `label` stay.

---

### `acp-permission-mode-selector` (refine existing)

**Status of shipped one-offs**:
- `hideLabel`: **keep**. Label suppression is an intentional semantic concern (not styling), well-named, small surface.
- `compact`: **keep but reframe as a variant prop**. Replace with `variant: "standalone" | "embedded"` (default `"standalone"`). The current `compact` boolean becomes `variant="embedded"` under the hood. Dual-write support both for one release.

**Tokens (P1)**:
- `--acp-select-bg`, `--acp-select-border`, `--acp-select-color`, `--acp-select-padding`, `--acp-select-radius`, `--acp-select-font-size`, `--acp-select-focus-border`
- `--acp-select-label-color`, `--acp-select-label-font-size`, `--acp-select-label-uppercase` (enum token: `uppercase | none`, defaults `uppercase`)

**Parts (P2)**:
- `part="label"`, `part="select"`.

This unblocks the obsidian-plugin's `.acp-permission-mode-select[data-mode="ask"] { border-color: var(--color-green); }` case. Plugin sets `acp-permission-mode-selector::part(select)` or writes `acp-permission-mode-selector[data-mode="ask"] { --acp-select-border: var(--color-green); }` on the wrapper.

---

### `acp-model-selector` (parity with mode selector)

Add `compact` / `variant: "embedded"` (missing today).
Same token set as `acp-permission-mode-selector` — both use the shared `--acp-select-*` namespace so a single host declaration themes both.

---

### `acp-text-field`

**Tokens (P1)** — extend `acpInputStyles`:
- `--acp-input-bg`, `--acp-input-border`, `--acp-input-color`, `--acp-input-padding`, `--acp-input-radius`, `--acp-input-font-size`, `--acp-input-focus-border`, `--acp-input-invalid-border`
- `--acp-label-color`, `--acp-label-font-size`, `--acp-label-font-weight`
- `--acp-input-error-color`

**Parts (P2)**:
- `part="label"`, `part="input"`, `part="textarea"`, `part="error"`.

---

### `acp-permission-modal`

**Parts (P2)** — primary mechanism:
- `part="backdrop"`, `part="card"`, `part="header"`, `part="tool-title"`, `part="raw-input"`, `part="message"`, `part="scope-section"`, `part="scope-heading"`, `part="scope-btn"` (forward state via `[aria-pressed]`), `part="options"`, `part="btn-allow"`, `part="btn-deny"`, `part="footer"`, `part="btn-reject"`.

**Tokens (P1)**:
- `--acp-modal-backdrop-bg`, `--acp-modal-backdrop-blur`
- `--acp-modal-card-bg`, `--acp-modal-card-border`, `--acp-modal-card-radius`, `--acp-modal-card-padding`, `--acp-modal-card-max-width`, `--acp-modal-card-shadow`

**Goal**: obsidian-plugin can delete its own `src/ui/permission-modal.ts` once part-level styling reaches parity. Requires host Modal integration (focus/Escape/z-index owned by Obsidian's Modal); that's out of scope for _styling_ but must be solved before the plugin can adopt. Addressed in section 6.

---

### `acp-elicitation-form`

**Tokens (P1)**:
- `--acp-form-bg`, `--acp-form-border`, `--acp-form-radius`, `--acp-form-padding`, `--acp-form-max-width`
- `--acp-form-header-color`, `--acp-form-header-size`, `--acp-form-title-size`, `--acp-form-description-size`
- Inherits input tokens from `acp-text-field` set.

**Parts (P2)**:
- `part="header"`, `part="title"`, `part="description"`, `part="field"`, `part="field-label"`, `part="field-input"`, `part="field-error"`, `part="actions"`, `part="btn-accept"`, `part="btn-decline"`, `part="btn-cancel"`.

---

### `acp-message`

**Tokens (P1)**:
- `--acp-message-padding`, `--acp-message-gap`
- `--acp-bubble-radius`, `--acp-bubble-radius-tail` (the asymmetric `4px` corner)
- `--acp-bubble-max-width`, `--acp-bubble-padding`, `--acp-bubble-font-size`, `--acp-bubble-line-height`
- `--acp-bubble-user-bg`, `--acp-bubble-user-color`
- `--acp-bubble-agent-bg`, `--acp-bubble-agent-color`
- `--acp-role-label-size`, `--acp-role-label-color-user`, `--acp-role-label-color-agent`

**Parts (P2)**:
- `part="bubble"`, `part="role-label"`, `part="copy-btn"`.

Hosts can distinguish user vs agent via `[data-role="user"]` / `[data-role="agent"]` on the bubble part.

---

### `acp-chat-app`

**Slots (P4)** — primary mechanism, given it's a composite:
- `slot="status-bar"` (replaces default `<acp-status-bar>`).
- `slot="transcript"` (replaces default `<acp-transcript>`).
- `slot="prompt-input"` (replaces default `<acp-prompt-input>`).
- `slot="overlays"` (replaces default `<acp-overlay-stack>`).

Hosts that don't slot anything get the default composition (today's behavior). Hosts that want partial replacement slot just the pieces they need.

**Tokens (P1)**:
- `--acp-chat-app-bg`, `--acp-chat-app-gap`.

---

## 5. Migration plan

### Upstream commits (`@agents-js/ui-components`)

Proposed commit order. Each commit is independently shippable (zero-breakage, purely additive).

1. **`feat(ui-components): add global shape tokens to acpTheme`** — add `--acp-border-radius`, `--acp-border-radius-sm`, `--acp-font-mono` to `acpTheme` as the shared defaults. ~1 file, ~6 lines. Unlocks the rest.
2. **`feat(ui-components): introduce per-component token convention + parts for acp-button, acp-permission-mode-selector, acp-model-selector`** — Class A control-level. ~3 files. Add `--acp-select-*` / `--acp-button-*` tokens, add `part=` attributes. _This is the first commit that unblocks the obsidian status-bar row jank._ See section 7.
3. **`feat(ui-components): parts + tokens for acp-text-field + acpInputStyles`** — fans out to all form controls that use the shared input styles (text-field, date-time-input, elicitation-form). ~4 files.
4. **`feat(ui-components): parts + tokens for acp-permission-modal + acp-modal + acp-write-gate-modal`** — Class B modal shape. ~3 files.
5. **`feat(ui-components): parts + tokens for acp-message + acp-transcript + acp-code-block`** — Class C text-level. Also fixes `acp-code-block` Obsidian-token leak (move to `--acp-code-block-border` that defaults to `--acp-border`). ~3 files.
6. **`feat(ui-components): slot-based composition for acp-chat-app + acp-status-bar + acp-debug-panel`** — Class D. ~3 files. Bigger because adding slots requires preserving the default composition as fallback content.
7. **`feat(ui-components): parts + tokens for remaining controls (checkbox, slider, choice-picker, date-time-input, auth-selector, connect-dialog)`** — cleanup pass. ~6 files.
8. **`docs(ui-components): theming guide in README + TSDoc on every tokenized component`** — documents the contract. Points downstream hosts at the conventions.

Commits 1–2 can ship in a single day. Commits 3–7 can fan out in parallel if multiple hands. Commit 8 is a low-effort follow-up.

**Can a single commit do the top 5 components?** Technically yes, but not recommended: each commit should be reviewable independently and each adds visible surface area to the public API. Better to stage.

### Downstream consumer migration

**obsidian-acp-plugin** (highest value):
- `src/ui/status-bar.ts`: replace `this.permissionModeEl.compact = true` with `this.permissionModeEl.setAttribute("variant", "embedded")` _once the token commit ships_. Delete the `data-mode` data-attribute hack and instead set CSS: `acp-permission-mode-selector::part(select) { --acp-select-border: var(--color-green); }` keyed on `[mode="ask"]` etc. Same for `acp-model-selector`.
- `styles.css`: replace the `.acp-permission-mode-select[data-mode="ask"] { border-color: ... }` rules with `acp-permission-mode-selector[mode="ask"]::part(select) { border-color: ... }`. This is a ~30-line simplification, lands same commit as the token adoption.
- `src/ui/permission-modal.ts`: **evaluate** deletion. Requires the SDK modal to integrate with Obsidian's Modal base class (focus trap, Escape, z-index). If that integration is out of scope, leave as-is — the styling contract doesn't force the swap.

**apps/web-ui**: no migration needed. Defaults preserve current look. Optional: adopt the new tokens in app-level theme overrides for consistency.

**apps/internal-gateway**: no direct ui-components consumers found in a quick scan (no `acp-*` tags in `apps/internal-gateway/src`). No migration.

### Backwards compatibility

- P1 (tokens): additive. Current hardcoded values become the default fallback for each new token. Existing consumers see zero change.
- P2 (parts): additive. `part=` attributes are invisible until a host targets them.
- P3 (variant renaming): `compact` → `variant="embedded"` is the only rename. Ship `compact` as a deprecated alias for one release with `console.warn` in dev builds. Remove in the following release.
- P4 (slots): adding a `<slot>` with default-content children is backwards-compatible. Hosts opt in.

**Single risk area**: the `acp-code-block` token-namespace fix (moves `--background-modifier-border` → `--acp-code-block-border` defaulting to `--acp-border`). Obsidian consumers that style via `--background-modifier-border` continue to work (those vars still exist at the app level), but the component no longer reads them directly. If any non-Obsidian host relied on the leak, they break. Risk rating: low — no evidence of such a consumer. Mitigation: keep a commented legacy fallback chain in the component for one release.

### Test strategy

- **Unit tests** (Vitest, existing pattern): assert that each tokenized component renders with expected CSS custom properties set on `:host`. Use `getComputedStyle(element).getPropertyValue('--acp-select-border')`. Extends the existing per-component test files under `packages/ui-components/tests/`.
- **Parts smoke test**: one test per component that queries `element.shadowRoot.querySelectorAll('[part]')` and asserts the expected parts list exists. Prevents accidental `part=` removal during refactors.
- **Visual regression**: optional. If agents-js adopts Playwright component tests later, snapshot each component in "default" and "host-override" render modes. Not required for the first ship — the contract is styling-additive.
- **Host-override integration test**: web-ui (the easiest host to instrument) gets one test that sets `--acp-select-border: red` on a wrapper and asserts the rendered select's border is red after shadow-DOM traversal. Proves the cascade works end-to-end in the environment we ship.

---

## 6. Risks and open questions

Items that aren't resolvable by code reading alone and need either a spike or a decision.

1. **Electron / Obsidian `::part()` support**: `::part()` selector standardized and widely supported in Chromium (since v73), which Obsidian's Electron baseline comfortably exceeds. BUT: Obsidian 1.4's bundled Electron is older than mainline. Verify by running a one-line spike in the plugin that selects `acp-permission-mode-selector::part(select)` and logs `getComputedStyle`. If any Obsidian user on Electron <85 is in the supported matrix, fall back to P1 tokens only for modals.
2. **CSS custom property specificity when hosts override from outside shadow root**: confirmed by MDN and spec — custom property values set on an ancestor of the shadow host inherit through the shadow boundary. Overrides from outside the shadow DOM participate in the normal cascade at the host element. No known Lit-specific bug. Low-risk, but worth one explicit test case (see test strategy above).
3. **Token proliferation governance**: if every component gets 10+ new tokens, the documented surface balloons. Open question: do we document every token or only "stable" ones and treat the rest as internal? Lean toward documenting only the ones explicitly in the per-component spec (section 4), and treating unmentioned ones as implementation detail subject to change.
4. **Modal integration with host Modal frameworks**: the styling contract for `acp-permission-modal` is solvable, but whether obsidian-plugin can actually _adopt_ `<acp-permission-modal>` depends on whether Obsidian's `Modal` class can host the SDK modal (focus trap, Escape, z-index). That's a separate architectural conversation orthogonal to theming. The theming contract should still land independently.
5. **Slot content and shadow-DOM style isolation**: slotted content lives in the light DOM and inherits light-DOM styles. Inner `::slotted()` rules in the SDK component can constrain slotted children, but if the host slots a whole replacement, the host's CSS owns its styling. This is the correct behavior — document it clearly.
6. **TypeScript typing for `::part` / CSS custom properties**: no compile-time typing for parts or custom properties in standard Lit. We could layer a helper type (`AcpButtonParts = "button" | "spinner"`) exported alongside each component for host authors to reference symbolically. Nice-to-have, not blocker.
7. **Mix-and-match compat with the `workflow-surface.ts` A2UI renderer path**: A2UI surfaces render the SDK components programmatically. The theming contract should apply equally there — verify by instrumenting the web-ui A2UI demo with a custom token set after commit #2 lands.

---

## 7. Recommended first commit

**Commit**: `feat(ui-components): introduce --acp-select-* and --acp-button-* token conventions + expose parts on acp-permission-mode-selector, acp-model-selector, acp-button`

**Scope** (single commit, ~150 LOC across 3 files + 3 test files):

1. Add the `--acp-select-*` token block to `acp-permission-mode-selector` and `acp-model-selector` (shared namespace — two components honor the same tokens).
2. Add the `--acp-button-*` token block to `acp-button`.
3. Add `part="label"` and `part="select"` to both selector components.
4. Add `part="button"` and `part="spinner"` to `acp-button`.
5. Rename `compact` on `acp-permission-mode-selector` to `variant="embedded"` (keep `compact` as a deprecated alias for one release). Add the same `variant` prop to `acp-model-selector`.
6. Extend existing tests to assert computed style reads the expected token values.

**Why this first**: it directly unblocks the Obsidian AGENT/MODE/MODEL row jank — which is the driving forcing function for this doc. Plugin change set required: ~30 lines (styles.css CSS-selector rewrite + ~5 TS attribute-name changes). Web-ui and other consumers unaffected (pure defaults).

**Followups unblocked**: commits 3–8 in the migration plan can then proceed in any order.

**Estimated effort**:
- Upstream commit: **S** (~2 hours including tests, review, docs nit).
- Downstream plugin adoption: **S** (~1 hour, one commit — CSS simplification + attr rename).
- Total including plan's optional rest-of-contract rollout (commits 3–7): **M** (~1–2 days fan-out).

---

## Appendix A — Inventory of hardcoded values per priority component

Captured here so the author of each upstream commit has a concrete list to convert into tokens. Format: `selector → property: value`.

### `acp-button`
- `button → border: 1px solid transparent`
- `button → border-radius: 6px`
- `button → font-weight: 600`
- `button → transition: background 0.15s, border-color 0.15s, opacity 0.15s`
- `button → line-height: 1.4`
- `button.size-sm → padding: 4px 10px; font-size: 12px`
- `button.size-md → padding: 8px 16px; font-size: 14px`
- `button.size-lg → padding: 12px 24px; font-size: 16px`
- `button:disabled → opacity: 0.4`
- `.spinner → border: 2px solid currentColor; animation: acp-spin 0.6s linear infinite`

### `acp-permission-mode-selector`
- `:host → padding: 4px 16px` (suppressed by `compact` today)
- `label → font-size: 11px; font-weight: 500; margin-right: 6px; text-transform: uppercase; letter-spacing: 0.05em`
- `select → padding: 3px 8px; border-radius: 4px; font-size: 12px; transition: border-color 0.15s`

### `acp-model-selector`
- `:host → gap: 6px`
- `label → same as above`
- `select → min-width: 180px; padding: 3px 8px; border-radius: 4px; font-size: 12px`

### `acp-permission-modal`
- `:host → z-index: 1000; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px)`
- `.card → padding: 24px 28px; max-width: 500px; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4)`
- `.header → font-size: 16px; font-weight: 700; margin-bottom: 16px`
- `button → padding: 8px 18px; border-radius: 6px; font-size: 13px; font-weight: 500`
- `.scope-btn → padding: 6px 12px; border-radius: 4px; font-size: 12px`

### `acp-message`
- `:host → padding: 4px 16px`
- `.bubble → max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.6`
- `.bubble--user → border-bottom-right-radius: 4px`
- `.bubble--agent → border-bottom-left-radius: 4px`
- `.role-label → font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; opacity: 0.7`
- `.copy-btn → padding: 2px 8px; font-size: 11px; border-radius: 4px`

---

**End of design doc.**
