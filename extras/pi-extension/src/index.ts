/**
 * Public surface of `@agents-js/pi-extension`.
 *
 * Pure barrel — the implementation lives in `./bridge.ts` and is re-exported
 * as the default. Consumers import the package's default to get the Pi
 * extension factory; named exports are not added here on purpose to keep the
 * public API a single shape.
 */
export { default } from "./bridge.ts";
