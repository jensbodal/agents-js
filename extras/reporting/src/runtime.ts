import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { runCommand } from "@agents-js/gateway-runtime";
import type { ReportingDeps } from "./types.ts";

export const defaultDeps: ReportingDeps = {
  runCommand,
  fetchText: async (url: string) => {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "agents-js-reporting/0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`Web fetch failed for ${url}: HTTP ${response.status}`);
    }

    return response.text();
  },
  writeFile: async (path: string, content: string) => {
    await Bun.write(path, content);
  },
  mkdirp: async (path: string) => {
    await mkdir(path, { recursive: true });
  },
  readFile: async (path: string) => Bun.file(path).text(),
};

export async function ensureParentDir(path: string, deps: ReportingDeps): Promise<void> {
  await deps.mkdirp(dirname(path));
}
