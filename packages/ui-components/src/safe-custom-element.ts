/**
 * HMR-safe replacement for Lit's `@customElement` decorator.
 *
 * Lit's built-in `@customElement(name)` calls `customElements.define(name, ctor)`
 * unconditionally. In hot-module-reload environments — Obsidian plugin soft
 * reloads, Vite HMR, Storybook, test harnesses that re-import modules, etc. —
 * the decorator runs again on a fresh class constructor for an already-registered
 * tag, which throws:
 *
 *   NotSupportedError: Failed to execute 'define' on 'CustomElementRegistry':
 *   the name "<tag>" has already been used with this registry.
 *
 * This wrapper behaves identically to Lit's decorator on first registration and
 * no-ops on re-registration so consumers can reload modules without crashing.
 *
 * Implementation notes:
 *   - Lit's decorator (see `@lit/reactive-element/decorators/custom-element.js`)
 *     supports both TC39 decorators (class decorator context with `addInitializer`)
 *     and legacy decorators (no context). We preserve both code paths.
 *   - The decorator only ever calls `customElements.define` — it does no other
 *     bookkeeping — so a guarded define is a full drop-in replacement.
 *   - If a different class attempts to re-register the same tag we emit a
 *     single `console.warn` and keep the existing registration. We do not
 *     swap classes at runtime because existing DOM nodes remain bound to the
 *     original constructor and swapping would desync them.
 */

type CustomElementClass = CustomElementConstructor;

// biome-ignore lint/suspicious/noExplicitAny: Matches Lit's decorator signature for both TC39 and legacy decorator contexts.
type ClassDecoratorContext = any;

/**
 * Idempotent variant of Lit's `@customElement` decorator.
 *
 * Usage is identical to the Lit decorator:
 *
 *   import { safeCustomElement } from "./safe-custom-element.ts";
 *
 *   \@safeCustomElement("acp-button")
 *   export class AcpButton extends LitElement { ... }
 */
export function safeCustomElement(tagName: string) {
  return (target: CustomElementClass, context?: ClassDecoratorContext): void => {
    const register = (): void => {
      // `customElements` may be absent in non-DOM environments where an element
      // module is imported for type/side-effect reasons only. Mirror Lit's
      // assumption that the global is present when the decorator actually runs.
      if (typeof customElements === "undefined") {
        return;
      }
      const existing = customElements.get(tagName);
      if (existing === undefined) {
        customElements.define(tagName, target);
        return;
      }
      if (existing !== target) {
        // Different class trying to re-register the same tag — keep the
        // first registration, warn once per duplicate so HMR sessions still
        // surface authoring mistakes (e.g. two different classes reusing a tag).
        console.warn(
          `[@agents-js/ui-components] safeCustomElement: tag "${tagName}" is already registered ` +
            "with a different class. Keeping the existing registration. This is expected during " +
            "hot-module reload; investigate if you are not in an HMR session.",
        );
      }
    };

    // TC39 class decorator context exposes `addInitializer`. Lit uses this to
    // defer registration until after the class body has fully initialized so
    // `accessor` fields and `@property` decorators are installed first.
    if (context !== undefined && typeof context.addInitializer === "function") {
      context.addInitializer(register);
      return;
    }

    // Legacy decorator path — register synchronously.
    register();
  };
}
