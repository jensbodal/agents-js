/**
 * Test preload: install a happy-dom global DOM before any test module (or the
 * Lit / ui-components import chain it pulls in) evaluates.
 *
 * Registered via `bunfig.toml` `preload`, NOT a top-of-file import: ESM import
 * hoisting would otherwise let `@agents-js/a2ui-*` touch `document` /
 * `customElements` before a top-level `register()` call ran. A preload module
 * is guaranteed to execute before the test files it precedes, so the global
 * DOM exists by the time Lit's `render()` and the `acp-*` custom elements load.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
