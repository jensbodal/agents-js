/**
 * Read-path sink for the lifestone agent-inbox projection (PROJECTION-SPEC.md
 * §3B). NOTE (Jens [Decision] 2026-06-08): the read-mirror is OPT-IN, NOT a
 * default always-on daemon. This module stays available for an explicit, scoped
 * opt-in render; the primary/default shape is the SEND maildrop (`send-path.ts`).
 *
 * Composes the pure render core (`renderInboxMessageToFile`) with a file writer
 * to turn ONE gateway inbox row into ONE lifestone `inbox/` file. The poller
 * (claude-channel-adapter `runInboxPoller`) owns the loop, dedup/seen-set,
 * identity guard, and at-most-once delivery; this sink owns only render+write.
 * It takes a structural `ProjectedInboxMessage` + an injected `writeFile`, so it
 * stays pure-testable with no gateway, no credentials, no adapter dependency.
 *
 * Invariant: writes a gateway row INTO the owner's own `inbox/`. It never writes
 * into another agent's mailbox; cross-agent delivery is the gateway's job.
 */

import {
  type ProjectedInboxMessage,
  type RenderedInboxFile,
  renderInboxMessageToFile,
} from "./render.ts";

/** Injected file writer: write `content` to `absolutePath` (mkdir -p semantics are the caller's). */
export type InboxWriteFn = (absolutePath: string, content: string) => void | Promise<void>;

export interface InboxRenderSinkOptions {
  /** The mailbox owner identity — its inbox is the only one this sink writes. */
  readonly owner: string;
  /** Absolute path to `hub/agent-inbox` (the vault mailbox root). */
  readonly mailboxRoot: string;
  /** Injected writer (production: `fs.writeFile` after mkdir; tests: a spy). */
  readonly writeFile: InboxWriteFn;
}

/**
 * A single path segment, reduced to a filename-safe token. Allowlist-based:
 * anything outside `[A-Za-z0-9._-]` (control bytes incl. NUL, whitespace, path
 * separators) collapses to `-`, then `..` runs collapse to `.` and leading/
 * trailing `.`/`-` are trimmed. So a hostile identity can neither traverse
 * (`../`) nor truncate a path (NUL). cognee-claude #164 defense-in-depth note.
 */
export function safePathSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/\.\.+/g, ".");
  return cleaned.replace(/^[.-]+|[.-]+$/g, "") || "unknown";
}

/**
 * Build the absolute path for an owner's `inbox/` file. `owner` is reduced to a
 * single safe path segment; `filename` already comes from
 * `renderInboxMessageToFile` and is filename-safe by construction.
 */
export function buildInboxFilePath(mailboxRoot: string, owner: string, filename: string): string {
  const root = mailboxRoot.replace(/\/+$/, "");
  return `${root}/${safePathSegment(owner)}/inbox/${filename}`;
}

/**
 * Build the `onMessage` sink. Each call renders the row to a lifestone file and
 * writes it under `<mailboxRoot>/<owner>/inbox/`. Idempotent at the file level:
 * render is deterministic, so re-delivering the same row writes a byte-identical
 * file at the same path.
 */
export function createInboxRenderSink(
  options: InboxRenderSinkOptions,
): (row: ProjectedInboxMessage) => Promise<RenderedInboxFile> {
  const { owner, mailboxRoot, writeFile } = options;
  return async (row: ProjectedInboxMessage): Promise<RenderedInboxFile> => {
    const rendered = renderInboxMessageToFile(row, owner);
    const path = buildInboxFilePath(mailboxRoot, owner, rendered.filename);
    await writeFile(path, rendered.content);
    return rendered;
  };
}
