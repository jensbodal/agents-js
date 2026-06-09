/**
 * Read-path sink for the lifestone agent-inbox projection (PROJECTION-SPEC.md,
 * increment b). Composes the pure render core (`renderInboxMessageToFile`) with
 * a file writer to turn ONE gateway inbox row into ONE lifestone `inbox/` file.
 *
 * This is the `onMessage` sink that `claude-channel-adapter`'s `runInboxPoller`
 * calls per new row — the poller owns the loop, dedup/seen-set, identity guard,
 * and at-most-once delivery; this sink owns only render+write. We deliberately
 * do NOT import the poller here: the sink takes a structural `ProjectedInboxMessage`
 * and an injected `writeFile`, so it stays pure-testable with no gateway, no
 * credentials, and no runtime dependency on the adapter. The thin runtime entry
 * that wires `runInboxPoller` -> this sink lives separately and is the only piece
 * needing the adapter's (currently internal) poller exports.
 *
 * Invariant (unchanged): this writes a gateway row INTO the owner's own `inbox/`.
 * It never writes into another agent's mailbox; cross-agent delivery is the
 * gateway's job, not the filesystem's.
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

/** A single path segment, stripped of separators / whitespace / traversal. */
export function safePathSegment(segment: string): string {
  const cleaned = segment.replace(/[\s/\\]+/g, "-").replace(/\.\.+/g, ".");
  return cleaned.replace(/^[.-]+|[.-]+$/g, "") || "unknown";
}

/**
 * Build the absolute path for an owner's `inbox/` file. `owner` is reduced to a
 * single safe path segment so a hostile identity can't traverse out of the
 * mailbox root; `filename` already comes from `renderInboxMessageToFile`
 * (stamp + sanitized-from + slug + `.md`), so it is filename-safe by construction.
 */
export function buildInboxFilePath(mailboxRoot: string, owner: string, filename: string): string {
  const root = mailboxRoot.replace(/\/+$/, "");
  return `${root}/${safePathSegment(owner)}/inbox/${filename}`;
}

/**
 * Build the `onMessage` sink for `runInboxPoller`. Each call renders the row to
 * a lifestone file and writes it under `<mailboxRoot>/<owner>/inbox/`. Returns
 * the `RenderedInboxFile` so callers/tests can assert on it. The sink is
 * idempotent at the file level: render is deterministic, so re-delivering the
 * same row writes a byte-identical file at the same path.
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
