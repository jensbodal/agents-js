/**
 * Progressive tool discovery index for the MCP bridge.
 *
 * Maps `tool_search` / `load_tool` primitives onto MCP's existing
 * `tools/list` + `tools/call` verbs (protocol-lineage note below).
 * Tools and skills are indexed in memory; a naive substring
 * match over name + description powers `tool_search`. `load_tool`
 * flips an MCP `RegisteredTool` from `disable()` to `enable()`, which
 * is the SDK's built-in mechanism for progressive exposure and
 * triggers `notifications/tools/list_changed` automatically.
 *
 * Protocol lineage: we do NOT introduce a new JSON-RPC verb. The
 * search + load primitives are plain MCP tools invoked via the
 * standard `tools/call` request. A2UI / ACP hosts that already speak
 * MCP need no extension. Clients that don't know about the primitives
 * see them as ordinary tools and can ignore them.
 */

/**
 * Source system that contributed a discoverable entry. Existing
 * sources: agents-bridged-as-MCP-tools, `@agents-js/skills` registry
 * entries, and freeform host-provided internal tools.
 */
export type DiscoveryEntrySource = "agent" | "skill" | "internal";

/**
 * Lightweight metadata returned by `tool_search`. Intentionally not
 * the full tool spec — just enough for an agent to decide whether to
 * follow up with `load_tool` (or, in non-progressive mode, a direct
 * `tools/call`).
 */
export interface DiscoveryEntry {
  /** Canonical name used to invoke the tool via `tools/call`. */
  name: string;
  /** Short human-readable description (agent-card, SKILL.md, or hand-written). */
  description: string;
  /** Origin system. */
  source: DiscoveryEntrySource;
  /** Optional tags to aid filtering. Not searched unless a future
   * caller opts in. */
  tags?: string[];
}

export interface SearchOptions {
  /** Maximum entries to return. Defaults to 20, capped at 100. */
  limit?: number;
}

/**
 * In-memory index. Rebuilt at bridge start; no persistence.
 *
 * Search is a case-insensitive substring match over `name` and
 * `description`. Empty / whitespace-only query returns the full
 * catalog (bounded by `limit`). No ranking beyond "name match beats
 * description match"; semantic ranking would require embeddings and is
 * intentionally out of scope for this in-memory index.
 */
export class DiscoveryIndex {
  private readonly entries = new Map<string, DiscoveryEntry>();

  /** Insert or replace an entry. Returns the stored entry for chaining. */
  add(entry: DiscoveryEntry): DiscoveryEntry {
    this.entries.set(entry.name, entry);
    return entry;
  }

  /** Remove an entry by name. Returns whether anything was removed. */
  remove(name: string): boolean {
    return this.entries.delete(name);
  }

  /** Fetch a single entry by exact name. */
  get(name: string): DiscoveryEntry | undefined {
    return this.entries.get(name);
  }

  /** Membership test. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Count of indexed entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Enumerate every entry, sorted by name for stable output. */
  list(): DiscoveryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Reset the index. */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Case-insensitive substring search over name + description.
   * Empty query returns the full catalog. Name-matches rank above
   * description-matches; ties break on lexical name order.
   */
  search(query: string, options: SearchOptions = {}): DiscoveryEntry[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const trimmed = query.trim().toLowerCase();

    if (trimmed.length === 0) {
      return this.list().slice(0, limit);
    }

    const nameHits: DiscoveryEntry[] = [];
    const descHits: DiscoveryEntry[] = [];

    for (const entry of this.list()) {
      if (entry.name.toLowerCase().includes(trimmed)) {
        nameHits.push(entry);
      } else if (entry.description.toLowerCase().includes(trimmed)) {
        descHits.push(entry);
      }
    }

    return [...nameHits, ...descHits].slice(0, limit);
  }
}
