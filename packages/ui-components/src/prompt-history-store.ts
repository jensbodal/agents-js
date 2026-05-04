/**
 * A framework-agnostic prompt history store that provides up-arrow input recall.
 *
 * Extracted from an earlier host prompt-history state machine and generalized here.
 * No DOM or Lit dependencies — pure TypeScript with optional async persistence.
 */

export interface PromptHistoryPersistence {
  load(): Promise<string[]>;
  save(entries: string[]): void; // fire-and-forget
}

export interface PromptHistoryStoreOptions {
  maxEntries?: number; // default: 100
  persistence?: PromptHistoryPersistence;
}

export interface HistoryNavResult {
  value: string;
  cursorPosition: number; // 0 = start, value.length = end
}

const DEFAULT_PROMPT_HISTORY_STORAGE_KEY = "acp-prompt-history";

function normalizeEntries(entries: string[], maxEntries: number): string[] {
  const deduped: string[] = [];
  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const existingIndex = deduped.indexOf(entry);
    if (existingIndex >= 0) {
      deduped.splice(existingIndex, 1);
    }
    deduped.push(entry);
  }
  return deduped.slice(-maxEntries);
}

export function createLocalStoragePromptHistoryPersistence(
  storageKey = DEFAULT_PROMPT_HISTORY_STORAGE_KEY,
): PromptHistoryPersistence {
  return {
    async load() {
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((entry): entry is string => typeof entry === "string");
      } catch {
        return [];
      }
    },
    save(entries) {
      try {
        localStorage.setItem(storageKey, JSON.stringify(entries));
      } catch {
        // localStorage unavailable — ignore silently
      }
    },
  };
}

export class PromptHistoryStore {
  private _entries: string[] = [];
  private _maxEntries: number;
  private _persistence: PromptHistoryPersistence | undefined;
  private _historyIndex = -1;
  private _savedInput = "";

  constructor(options?: PromptHistoryStoreOptions) {
    this._maxEntries = options?.maxEntries ?? 100;
    this._persistence = options?.persistence;
  }

  async init(): Promise<void> {
    if (this._persistence) {
      const loadedEntries = normalizeEntries(await this._persistence.load(), this._maxEntries);
      this._entries = normalizeEntries([...loadedEntries, ...this._entries], this._maxEntries);
    }
  }

  getEntries(): readonly string[] {
    return this._entries;
  }

  get length(): number {
    return this._entries.length;
  }

  get isNavigating(): boolean {
    return this._historyIndex >= 0;
  }

  push(text: string): void {
    const entry = text.trim();
    if (!entry) return;

    this._entries = normalizeEntries([...this._entries, entry], this._maxEntries);
    this.resetNavigation();
    this._persistence?.save([...this._entries]);
  }

  navigateUp(currentInput: string): HistoryNavResult | null {
    if (this._entries.length === 0) return null;

    if (this._historyIndex === -1) {
      this._savedInput = currentInput;
      this._historyIndex = this._entries.length - 1;
    } else if (this._historyIndex > 0) {
      this._historyIndex--;
    }
    // At oldest entry (index === 0), stay on first entry

    const entry = this._entries[this._historyIndex];
    if (entry === undefined) return null;

    return {
      value: entry,
      cursorPosition: 0,
    };
  }

  navigateDown(): HistoryNavResult | null {
    if (this._historyIndex < 0) return null;

    if (this._historyIndex < this._entries.length - 1) {
      this._historyIndex++;
      const entry = this._entries[this._historyIndex];
      if (entry === undefined) return null;
      return {
        value: entry,
        cursorPosition: entry.length,
      };
    }

    // Past newest — restore saved input and exit navigation
    const value = this._savedInput;
    this.resetNavigation();
    return {
      value,
      cursorPosition: value.length,
    };
  }

  resetNavigation(): void {
    this._historyIndex = -1;
    this._savedInput = "";
  }

  clear(): void {
    this._entries = [];
    this.resetNavigation();
    this._persistence?.save([]);
  }
}
