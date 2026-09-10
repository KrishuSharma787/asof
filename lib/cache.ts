// In-memory only: each serverless invocation may get a cold instance, so this
// is a best-effort cost saver, not a guaranteed cache. Upgrade to Vercel KV
// if repeat-query volume ever makes that gap matter.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

export function buildCacheKey(actName: string, section: string | null): string {
  const normalizedAct = actName.trim().toLowerCase();
  const normalizedSection = section?.trim().toLowerCase() ?? "";
  return `${normalizedAct}::${normalizedSection}`;
}

export function getCached<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function setCached<T>(key: string, value: T, ttlMs: number = DEFAULT_TTL_MS): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}
