/**
 * Browser-safe entry point for @agents-js/gateway-runtime.
 *
 * The main entry (src/index.ts) pulls in runtime-registry + detection
 * machinery that depends on `styleText` from `node:util`, which Bun's
 * browser polyfill does not expose. Bundling the main entry for a browser
 * target therefore fails.
 *
 * Browser consumers never spawn child processes or resolve runtime
 * selection, so the PATH-augmentation list has no runtime meaning in a
 * browser bundle. An empty frozen array is the correct browser-side
 * answer; the moment a downstream re-export reaches a browser bundle
 * without a matching stub here, the bundler hard-fails with `No matching
 * export in browser.mjs for import "<symbol>"` (this exact failure was
 * observed in obsidian-acp-plugin's preview:build before this stub
 * landed).
 *
 * Keep this entry minimal. If a new browser consumer starts transitively
 * depending on another gateway-runtime export, add the narrowest stub
 * needed here (preferring empty/frozen values over throwing — the harness
 * loads this at bundle time and throwing would break preview-build
 * entirely rather than safely stubbing).
 */

export const DEFAULT_EXTRA_BIN_PATHS: readonly string[] = Object.freeze([]);
