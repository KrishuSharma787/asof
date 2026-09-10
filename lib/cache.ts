// In-memory only: each serverless invocation may get a cold instance, so this
// is a best-effort cost saver, not a guaranteed cache. Upgrade to Vercel KV
// if repeat-query volume ever makes that gap matter.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

// The citation graph is computed by a second request (see
// app/api/citations/route.ts) so its Groq calls stay off the critical path.
// That request needs the same retrieved judgment texts the first one used,
// and they are far too large to hand back through the browser, so they are
// parked here under a parallel key instead.
export function buildSourcesCacheKey(actName: string, section: string | null): string {
  return `sources::${buildCacheKey(actName, section)}`;
}

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
