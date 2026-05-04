/**
 * Browser-safe entry point for @agents-js/acp-host/editor.
 *
 * The mention-parser helpers and the frontmatter-only-write detector are
 * pure framework-agnostic TypeScript functions with no Node-specific
 * runtime dependencies (only type-only SDK imports where used), so the
 * browser surface is identical to the main surface in practice.
 *
 * This entry exists to give browser-target bundlers (via the `browser`
 * package.json export condition) an explicit hand-off, so downstream
 * consumers never need to reach into `src/` or author shims. Any future
 * editor utility additions that DO require Node-only APIs must either (a)
 * be excluded from this file, or (b) ship a browser-safe stub here —
 * preferring empty/frozen values over throwing so test harnesses that
 * load the module at bundle time don't break on import.
 */

export type { FrontmatterWriteTarget } from "./frontmatter.ts";
export { detectFrontmatterOnlyWrite, splitMarkdownFrontmatter } from "./frontmatter.ts";
export type { OpenFileEntry } from "./mention-parser.ts";
export {
  buildInlineContext,
  filterFiles,
  getMentionAtCursor,
  parseMentions,
  resolveMentions,
} from "./mention-parser.ts";
