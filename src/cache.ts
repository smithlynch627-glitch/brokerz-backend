// Deliberately simple - a Map with expiry timestamps. This is a testnet
// single-process backend, not a distributed system, so there's no need for
// Redis or anything external here. If this ever runs as multiple instances
// behind a load balancer, swap this for a shared cache (Redis) so they
// don't each hammer the RPC independently.

type Entry<T> = { value: T; expiresAt: number };

const store = new Map<string, Entry<unknown>>();
const stale = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();

export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Returns a cached value when fresh. On a miss, concurrent callers share a
 * single in-flight request rather than each triggering their own, and if that
 * request fails the last known good value is served instead of an error.
 * Both matter on Robinhood's public RPC, which is rate limited.
 */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const existing = cacheGet<T>(key);
  if (existing !== undefined) return existing;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    try {
      const value = await fn();
      cacheSet(key, value, ttlMs);
      stale.set(key, value);
      return value;
    } catch (err) {
      const lastGood = stale.get(key);
      if (lastGood !== undefined) return lastGood as T;
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** Drops a specific key so the next read refetches. */
export function cacheInvalidate(key: string): void {
  store.delete(key);
}
