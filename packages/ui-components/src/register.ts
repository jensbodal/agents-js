/**
 * Marker function for hosts that prefer an explicit
 * `registerAllComponents()` call after importing
 * `@agents-js/ui-components`. **The function body is intentionally
 * empty.**
 *
 * Actual `<acp-*>` registration is a side effect of importing the barrel
 * — every component module under `./acp-*.ts` declares its custom element
 * via Lit's `@customElement` decorator, which runs at module evaluation.
 * The package's `index.ts` re-exports each of them by name, so importing
 * `@agents-js/ui-components` (or any of its named exports) registers
 * every element.
 *
 * Calling this function never registers anything on its own — to call
 * it, you have to import it from `@agents-js/ui-components`, and that
 * import already triggered the registration. The function exists only
 * for hosts whose bootstrap code expects an explicit
 * "register UI components" step; the call is safe but a no-op.
 */
export function registerAllComponents(): void {
  // Intentionally empty — see JSDoc.
}
