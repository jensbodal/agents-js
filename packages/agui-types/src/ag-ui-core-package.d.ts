// Ambient declaration for the JSON subpath of `@ag-ui/core`.
//
// `@ag-ui/core` exports `./package.json` in its `exports` map but ships no
// `.d.json.ts` declaration. TypeScript's `bundler` resolution strips the
// `.json` extension when looking for types, fails to find one, and then
// reports the subpath as missing — even though Bun resolves it correctly
// at runtime. This shim gives the typechecker just enough shape so
// `import agUiCorePkg from "@ag-ui/core/package.json"` typechecks cleanly.
declare module "@ag-ui/core/package.json" {
  const pkg: { version: string };
  export default pkg;
}
