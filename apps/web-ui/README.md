# @agents-js/web-ui

Reference browser consumer for `agents-js`.

This app composes `@agents-js/a2a-client` with `@agents-js/ui-components` to render the shared
A2A/ACP workflow surfaces in a browser shell.

This is not just a demo. It is the upstream proof surface for the reusable browser-facing SDK
contract: shared workflow surfaces, browser guidance, and the behavior documented in the public
docs should all hold here.

## Local Development

From this directory:

```sh
bun run dev
bun run build
bun run preview
```

## Notes

- Intended as the browser-facing reference surface for docs, browser proof, release proof, and UI iteration.
- Keep host/runtime behavior in the shared packages; this app should stay thin.
- For repo-level proof, prefer the root commands `bun run dev`,
  `bun run browser:smoke`, `bun run e2e:web:live -- --runtime claude`, and
  `bun run docs:build`.
