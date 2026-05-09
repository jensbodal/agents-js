export interface CacheClearResult {
  cleared: boolean;
  count?: number;
  reason?: string;
}

const WEBLLM_PREFIX = "webllm/";

export async function clearModelCache(): Promise<CacheClearResult> {
  const caches = (
    globalThis as unknown as {
      caches?: { keys: () => Promise<string[]>; delete: (key: string) => Promise<boolean> };
    }
  ).caches;
  if (!caches) return { cleared: false, reason: "no-cache-api" };
  const keys = await caches.keys();
  const targets = keys.filter((k) => k.startsWith(WEBLLM_PREFIX));
  await Promise.all(targets.map((k) => caches.delete(k)));
  return { cleared: true, count: targets.length };
}
