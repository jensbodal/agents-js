import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repoRoot } from "./workspace-config.ts";

const lockPath = path.join(repoRoot, ".tmp", "external-consumer-smoke.lock");
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 100;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export async function withExternalConsumerSmokeLock<T>(
  callback: () => Promise<T>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });

  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for external consumer smoke lock: ${lockPath}`);
      }

      await delay(POLL_INTERVAL_MS);
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
