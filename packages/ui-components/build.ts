/**
 * Custom build script for @agents-js/ui-components.
 *
 * Uses esbuild for the JS bundle (handles TC39 decorator transformation)
 * and tsdown for .d.mts type declarations only.
 *
 * tsdown/Rolldown does not yet transform TC39 decorators (the `accessor`
 * keyword + `@customElement`/`@property` from Lit). esbuild handles these
 * correctly when targeting es2022 or below.
 */

import { rmSync } from "node:fs";
import * as esbuild from "esbuild";

// Clean dist/
rmSync("dist", { recursive: true, force: true });

// Step 1: Generate .d.mts types + JS with tsdown (types are correct, JS has raw decorators)
const tsdown = Bun.spawn(
  [
    "bunx",
    "tsdown",
    "src/index.ts",
    "src/connect-preferences-store.ts",
    "src/web-ui-glue.ts",
    "--format",
    "esm",
    "--dts",
    "--out-dir",
    "dist",
  ],
  { stdio: ["inherit", "inherit", "inherit"] },
);
await tsdown.exited;

if (tsdown.exitCode !== 0) {
  console.error("tsdown failed");
  process.exit(1);
}

// Step 2: Overwrite JS with esbuild (transforms TC39 decorators correctly)
const indexResult = await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/index.mjs",
  external: ["lit", "lit/*", "@agents-js/*"],
  target: "es2022",
  sourcemap: false,
});

if (indexResult.errors.length > 0) {
  console.error("esbuild errors:", indexResult.errors);
  process.exit(1);
}

const connectPreferencesResult = await esbuild.build({
  entryPoints: ["src/connect-preferences-store.ts"],
  bundle: false,
  format: "esm",
  outfile: "dist/connect-preferences-store.mjs",
  target: "es2022",
  sourcemap: false,
});

if (connectPreferencesResult.errors.length > 0) {
  console.error("esbuild errors:", connectPreferencesResult.errors);
  process.exit(1);
}

const webUiGlueResult = await esbuild.build({
  entryPoints: ["src/web-ui-glue.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/web-ui-glue.mjs",
  external: ["lit", "lit/*", "@agents-js/*"],
  target: "es2022",
  sourcemap: false,
});

if (webUiGlueResult.errors.length > 0) {
  console.error("esbuild errors:", webUiGlueResult.errors);
  process.exit(1);
}

console.log("✓ Build complete (esbuild JS + tsdown dts)");
