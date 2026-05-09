import { describe, expect, test } from "bun:test";
import type { PromptHistoryPersistence } from "../src/prompt-history-store.ts";
import {
  createLocalStoragePromptHistoryPersistence,
  PromptHistoryStore,
} from "../src/prompt-history-store.ts";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PromptHistoryStore navigation", () => {
  test("navigateUp on empty store returns null", () => {
    const store = new PromptHistoryStore();
    expect(store.navigateUp("current")).toBeNull();
  });

  test("navigateUp first call saves currentInput, returns newest entry with cursorPosition 0", () => {
    const store = new PromptHistoryStore();
    store.push("hello");
    store.push("world");

    const result = store.navigateUp("current text");
    expect(result).not.toBeNull();
    expect(result?.value).toBe("world");
    expect(result?.cursorPosition).toBe(0);
  });

  test("multiple navigateUp calls walk backward", () => {
    const store = new PromptHistoryStore();
    store.push("first");
    store.push("second");
    store.push("third");

    const r1 = store.navigateUp("current");
    expect(r1?.value).toBe("third");

    const r2 = store.navigateUp("current");
    expect(r2?.value).toBe("second");

    const r3 = store.navigateUp("current");
    expect(r3?.value).toBe("first");
  });

  test("navigateUp at oldest stays on first entry", () => {
    const store = new PromptHistoryStore();
    store.push("only");

    const r1 = store.navigateUp("current");
    expect(r1?.value).toBe("only");

    const r2 = store.navigateUp("current");
    expect(r2).not.toBeNull();
    expect(r2?.value).toBe("only");
  });

  test("navigateDown walks forward with cursorPosition at end", () => {
    const store = new PromptHistoryStore();
    store.push("first");
    store.push("second");
    store.push("third");

    store.navigateUp("current");
    store.navigateUp("current");
    store.navigateUp("current");

    const r1 = store.navigateDown();
    expect(r1?.value).toBe("second");
    expect(r1?.cursorPosition).toBe("second".length);

    const r2 = store.navigateDown();
    expect(r2?.value).toBe("third");
    expect(r2?.cursorPosition).toBe("third".length);
  });

  test("navigateDown past newest restores saved input and exits navigation", () => {
    const store = new PromptHistoryStore();
    store.push("entry");

    store.navigateUp("my draft");
    expect(store.isNavigating).toBe(true);

    const result = store.navigateDown();
    expect(result?.value).toBe("my draft");
    expect(result?.cursorPosition).toBe("my draft".length);
    expect(store.isNavigating).toBe(false);
  });
});

describe("PromptHistoryStore push", () => {
  test("push adds entry", () => {
    const store = new PromptHistoryStore();
    store.push("hello");
    expect(store.length).toBe(1);
    expect(store.getEntries()[0]).toBe("hello");
  });

  test("push caps at maxEntries", () => {
    const store = new PromptHistoryStore({ maxEntries: 3 });
    store.push("a");
    store.push("b");
    store.push("c");
    store.push("d");
    expect(store.length).toBe(3);
    expect(store.getEntries()).toEqual(["b", "c", "d"]);
  });

  test("push de-duplicates repeated entries by moving them to the end", () => {
    const store = new PromptHistoryStore();
    store.push("hello");
    store.push("world");
    store.push("hello");
    expect(store.getEntries()).toEqual(["world", "hello"]);
  });

  test("push resets navigation state", () => {
    const store = new PromptHistoryStore();
    store.push("first");
    store.push("second");

    store.navigateUp("draft");
    expect(store.isNavigating).toBe(true);

    store.push("third");
    expect(store.isNavigating).toBe(false);
  });
});

describe("PromptHistoryStore persistence", () => {
  test("push calls persistence.save() with current entries array", () => {
    let savedEntries: string[] = [];
    const persistence: PromptHistoryPersistence = {
      async load() {
        return [];
      },
      save(entries) {
        savedEntries = entries;
      },
    };
    const store = new PromptHistoryStore({ persistence });
    store.push("hello");
    expect(savedEntries).toEqual(["hello"]);

    store.push("world");
    expect(savedEntries).toEqual(["hello", "world"]);
  });

  test("init() loads and normalizes persisted entries", async () => {
    const persistence: PromptHistoryPersistence = {
      async load() {
        return [" first ", "", "second", "first"];
      },
      save() {},
    };
    const store = new PromptHistoryStore({ persistence });
    await store.init();
    expect(store.getEntries()).toEqual(["second", "first"]);
  });

  test("init() preserves entries pushed before async persistence finishes loading", async () => {
    const deferred = createDeferred<string[]>();
    const persistence: PromptHistoryPersistence = {
      load() {
        return deferred.promise;
      },
      save() {},
    };
    const store = new PromptHistoryStore({ persistence });

    const initPromise = store.init();
    store.push("fresh");
    deferred.resolve(["saved"]);
    await initPromise;

    expect(store.getEntries()).toEqual(["saved", "fresh"]);
  });

  test("clear() empties entries and calls persistence.save([])", () => {
    let savedEntries: string[] | null = null;
    const persistence: PromptHistoryPersistence = {
      async load() {
        return [];
      },
      save(entries) {
        savedEntries = entries;
      },
    };
    const store = new PromptHistoryStore({ persistence });
    store.push("a");
    store.push("b");
    expect(store.length).toBe(2);

    store.clear();
    expect(store.length).toBe(0);
    expect(store.getEntries()).toEqual([]);
    expect(savedEntries).toEqual([]);
  });

  test("localStorage persistence adapter ignores malformed JSON", async () => {
    const storage: Record<string, string> = {
      "acp-prompt-history": "not-json",
    };
    globalThis.localStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {},
      get length() {
        return Object.keys(storage).length;
      },
      key: (index: number) => Object.keys(storage)[index] ?? null,
    };

    const persistence = createLocalStoragePromptHistoryPersistence();
    expect(await persistence.load()).toEqual([]);
  });
});
