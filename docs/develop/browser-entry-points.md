---
title: Browser Entry Points
---

# Browser Entry Points

Some packages expose a browser-safe entry point through a `browser` export
condition. Use this only when browser bundlers need a package-level symbol
from a package whose normal entry imports Node/Bun-only modules.

## Convention

Use `src/browser.ts` as the browser-specific source entry. In
`package.json`, route the package root through the `browser` condition:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "browser": "./dist/browser.mjs",
      "bun": "./src/index.ts",
      "import": "./dist/index.mjs",
      "default": "./dist/index.mjs"
    }
  }
}
```

Build both entries in the package build script:

```sh
bunx tsdown src/index.ts src/browser.ts --format esm --dts --out-dir dist --clean
```

## Export Discipline

Keep `src/browser.ts` narrow. Export only the symbols that a browser-bound
consumer actually imports through the package boundary. Do not mirror the
main entry by default.

For data-only symbols that have no browser meaning but are imported
transitively, prefer frozen empty stubs:

```ts
export const SOME_ENV_KEY_LIST: readonly string[] = Object.freeze([]);
```

Frozen empty arrays or objects make bundle-time imports deterministic and
prevent browser code from accidentally mutating shared placeholder state.

For packages that are inherently server-only, an intentional throw stub is
acceptable. Use it when any browser import would be a real integration bug
and failing loudly is clearer than pretending the package has a browser
surface:

```ts
throw new Error("@agents-js/example-server is a Node/Bun runtime and cannot run in a browser.");
```

## What Not To Do

Do not re-export `./index.ts` from `src/browser.ts` just to satisfy a
bundler. If the main entry already works in browsers, the package does not
need a `browser` condition. If the main entry imports server-only modules,
re-exporting it hides the problem until a downstream preview build fails.

Do not add broad placeholder APIs. Every stub should map to a real import
that browser consumers need today, and every new symbol should explain
whether it is a frozen no-op value, a browser-safe implementation, or an
intentional throw.

## Review Checklist

- The package has a real browser consumer or a known transitive browser
  import.
- `src/browser.ts` exports the minimum viable surface.
- `package.json` uses a root `browser` export condition.
- The build script emits `src/browser.ts`.
- Empty placeholders are frozen.
- Server-only packages throw intentionally instead of pretending to run in
  the browser.
- `src/browser.ts` does not re-export `./index.ts` as a bundler workaround.
