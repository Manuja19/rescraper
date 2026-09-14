// Simple in-memory cache for Workers (ephemeral per isolate)
const cache = new Map<string, { value: any; expiry: number }>();

export function cacheGet<T>(key: string): T | undefined {
  const item = cache.get(key);
  if (!item) return undefined;
  
  // Check expiry on read (no background timer needed)
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return undefined;
  }
  
  return item.value as T;
}

export function cacheSet<T>(key: string, value: T, ttlSeconds: number = 3600): void {
  cache.set(key, {
    value,
    expiry: Date.now() + (ttlSeconds * 1000)
  });
}
