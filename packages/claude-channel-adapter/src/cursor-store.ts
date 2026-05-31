/**
 * `CursorStore` — restart-safe dedup state for {@link InboxPoller}.
 *
 * The gateway `get_messages` API is limit-based (returns the most-recent N
 * rows); it has no server-side cursor. So dedup is entirely client-side: we
 * persist a bounded set of recently-seen dedup keys and skip any row whose key
 * is already present. Persisting across restarts is what stops a relaunch from
 * re-surfacing every row currently in the inbox window as a fresh `<channel>`.
 *
 * The store is an injected interface so the poll loop stays pure and testable
 * with an in-memory implementation; the file-backed implementation is the
 * production default.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Bounded most-recently-seen dedup-key state. */
export interface CursorState {
  /** Most-recent dedup keys (idempotency_key ?? message_id), newest last. */
  seen: string[];
}

export interface CursorStore {
  load(): CursorState;
  save(state: CursorState): void;
}

/** In-memory store — for tests and ephemeral runs. */
export class MemoryCursorStore implements CursorStore {
  constructor(private state: CursorState = { seen: [] }) {}
  load(): CursorState {
    return { seen: [...this.state.seen] };
  }
  save(state: CursorState): void {
    this.state = { seen: [...state.seen] };
  }
}

/**
 * File-backed store. Reads tolerate a missing/corrupt file (returns empty
 * state) so a first run or a clobbered cursor never crashes the launcher — at
 * worst it re-surfaces the current inbox window once.
 */
export class FileCursorStore implements CursorStore {
  constructor(private readonly path: string) {}
  load(): CursorState {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<CursorState>;
      return {
        seen: Array.isArray(parsed.seen) ? parsed.seen.filter((s) => typeof s === "string") : [],
      };
    } catch {
      return { seen: [] };
    }
  }
  save(state: CursorState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(state), "utf8");
  }
}
