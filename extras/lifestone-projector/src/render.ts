/**
 * Pure render/parse core for the lifestone agent-inbox projection
 * (PROJECTION-SPEC.md, increment a). NO I/O, NO credentials, NO clock
 * dependency — every output is a deterministic function of its inputs,
 * so the read/write daemon legs (increments b/c) can be built and tested
 * on top without touching the gateway.
 *
 * Boundary reminder (the load-bearing invariant): this module renders a
 * gateway inbox row INTO a lifestone file and parses a human-composed
 * outbox file OUT into a send request. It NEVER routes a file directly
 * into another agent's inbox — all inter-agent delivery goes through the
 * gateway `send_message`. Lifestone is a view, never a second router.
 */

/**
 * Structural mirror of `MatrixOrigin` from
 * `@agents-js/claude-channel-adapter`'s `gateway-inbox-client.ts`.
 * Duplicated as a structural type so this pure package carries no runtime
 * dependency on the adapter (avoids a coupling cycle; same pattern as
 * `host/matrix-bus-consumer.ts`).
 */
export interface ProjectedMatrixOrigin {
  readonly event_id?: string;
  readonly room_id?: string;
  readonly sender?: string;
  readonly origin_server_ts?: number;
  readonly reply_to_event_id?: string;
}

/** Structural mirror of `InboxMessage` (one durable-inbox row). */
export interface ProjectedInboxMessage {
  readonly message_id: string;
  readonly created_at?: string | number;
  readonly body: string;
  readonly kind?: string;
  readonly idempotency_key?: string | null;
  readonly matrix_origin?: ProjectedMatrixOrigin;
  readonly sender?: string;
}

/** A rendered lifestone inbox file: where to write it + what it contains. */
export interface RenderedInboxFile {
  readonly filename: string;
  readonly content: string;
  /** Stable dedup token; identical across daemon restarts for the same row. */
  readonly dedupKey: string;
}

/** Result of parsing a human-composed `outbox/` file. */
export type OutboxParseResult =
  | { readonly ok: true; readonly to: string; readonly body: string; readonly id?: string }
  | { readonly ok: false; readonly error: string };

/**
 * Stable dedup key for an inbox row. Bridge-fanout rows carry
 * `idempotency_key` (`${matrix_event_id}:${target_session}`); native sends
 * carry NULL, so we fall back to `message_id`. Per the InboxMessage contract.
 */
export function dedupKey(msg: ProjectedInboxMessage): string {
  const k = msg.idempotency_key;
  return k != null && k !== "" ? k : msg.message_id;
}

/** Lowercase kebab slug, ASCII-only, max ~6 words, for filenames. */
export function slugify(text: string, maxWords = 6): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join("-");
  return slug || "message";
}

/** Strip MXID punctuation so a sender is filename-safe (`@a:b` → `a-b`). */
export function sanitizeForFilename(id: string): string {
  return (
    id
      .replace(/^@/, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

/** Resolve the row's authoritative timestamp (ms epoch), if any. */
export function resolveTimestampMs(msg: ProjectedInboxMessage): number | undefined {
  const fromOrigin = msg.matrix_origin?.origin_server_ts;
  if (typeof fromOrigin === "number") return fromOrigin;
  const c = msg.created_at;
  if (typeof c === "number") return c;
  if (typeof c === "string") {
    const parsed = Date.parse(c);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** Compact, lexically-sortable UTC stamp for filenames: `20260608T211900Z`. */
export function toCompactStamp(ms: number): string {
  // `new Date(ms)` is deterministic given `ms` (no wall-clock read).
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Author of a row: matrix sender wins, else the native `sender`, else unknown. */
export function resolveFrom(msg: ProjectedInboxMessage): string {
  return msg.matrix_origin?.sender ?? msg.sender ?? "unknown";
}

/**
 * Render a gateway inbox row into a lifestone `inbox/` file. Pure +
 * deterministic given `(msg, ownerIdentity)`. The daemon is responsible
 * for NOT writing a row whose `dedupKey` it has already rendered.
 */
export function renderInboxMessageToFile(
  msg: ProjectedInboxMessage,
  ownerIdentity: string,
): RenderedInboxFile {
  const from = resolveFrom(msg);
  const ms = resolveTimestampMs(msg);
  const stamp = ms !== undefined ? toCompactStamp(ms) : "00000000T000000Z";
  const tsIso = ms !== undefined ? new Date(ms).toISOString() : "";
  const inReplyTo = msg.matrix_origin?.reply_to_event_id ?? "";
  const filename = `${stamp}__${sanitizeForFilename(from)}__${slugify(msg.body)}.md`;

  const frontmatter = [
    "---",
    `id: ${msg.message_id}`,
    `gateway_id: ${msg.message_id}`,
    `from: ${from}`,
    `to: ${ownerIdentity}`,
    `ts: ${tsIso}`,
    `in_reply_to: ${inReplyTo}`,
    `kind: ${msg.kind ?? "agents_message"}`,
    "state: rendered",
    "---",
    "",
  ].join("\n");

  return {
    filename,
    content: `${frontmatter}${msg.body}\n`,
    dedupKey: dedupKey(msg),
  };
}

/**
 * Parse a human-composed `outbox/` file into a send request. Frontmatter
 * keys recognized: `to` (required), `id` (optional client dedup token).
 * Everything after the closing `---` is the message body. A missing/empty
 * `to` is a typed failure, NOT a guess — the daemon must not send it.
 */
export function parseOutboxFile(content: string): OutboxParseResult {
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!fm) return { ok: false, error: "no frontmatter block (--- … ---) found" };

  const headerBlock = fm[1] ?? "";
  const bodyBlock = fm[2] ?? "";

  const headers: Record<string, string> = {};
  for (const line of headerBlock.split("\n")) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (m?.[1]) headers[m[1]] = (m[2] ?? "").trim();
  }

  const to = headers.to;
  if (!to) return { ok: false, error: "missing required `to` in frontmatter" };

  const body = bodyBlock.trim();
  if (!body) return { ok: false, error: "empty message body" };

  return headers.id ? { ok: true, to, body, id: headers.id } : { ok: true, to, body };
}
