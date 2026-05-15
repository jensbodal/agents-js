import { HstVue } from "@histoire/plugin-vue";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "histoire";

/**
 * Histoire config for the agents-js component sandbox.
 *
 * Hosts deterministic stories for the Lit-based `acp-*` web components.
 * Build output lands directly inside the VitePress `public/` tree so the
 * catalog ships as static assets under `https://<docs-host>/components/`.
 *
 * Framework note: Histoire 1.0 has no published "vanilla" plugin (the npm
 * package `@histoire/plugin-vanilla` does not exist). Stories are authored
 * as `.story.vue` files. Lit components are embedded inside `<template>`
 * blocks and Vue's compiler is told to treat any `acp-*` tag as a custom
 * element via `compilerOptions.isCustomElement`. The components themselves
 * register on import (via `@safeCustomElement`); no Vue-side wrapping is
 * needed.
 */
export default defineConfig({
  plugins: [HstVue()],
  setupFile: "./stories/setup.ts",
  storyMatch: ["stories/**/*.story.vue"],
  outDir: "../../docs/public/components",
  vite: {
    base: "/components/",
    // Mirror `docs/.vitepress/config.mts`: esbuild's default target predates
    // TC39 decorators + `accessor` syntax. Bumping to es2022 lets the client
    // bundle transform Lit decorator syntax correctly. (SSR collection
    // sidesteps the same issue by importing the prebuilt `dist/` artifact;
    // see `stories/setup.ts`.)
    esbuild: {
      target: "es2022",
    },
    plugins: [
      vue({
        template: {
          compilerOptions: {
            isCustomElement: (tag) => tag.startsWith("acp-"),
          },
        },
      }),
    ],
  },
  theme: {
    title: "agents-js components",
  },
});
