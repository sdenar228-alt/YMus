// VkUrlCache — кэш прямых URL для аудио ВКонтакте с TTL и LRU-вытеснением.

export interface VkCacheEntry {
  url: string;
  key: string; // "{ownerId}:{audioId}"
  timestamp: number;
}

export class VkUrlCache {
  private readonly maxEntries = 50;
  private readonly ttlMs = 10 * 60 * 1000; // 10 minutes

  private readonly entries = new Map<string, VkCacheEntry>();

  /**
   * Store a URL for a VK audio track.
   * Key: "{ownerId}:{audioId}"
   * Evicts oldest entry if cache exceeds maxEntries.
   */
  set(ownerId: string, audioId: string, url: string): void {
    const key = `${ownerId}:${audioId}`;
    const entry: VkCacheEntry = { url, key, timestamp: Date.now() };
    this.entries.set(key, entry);

    if (this.entries.size > this.maxEntries) {
      this.evictOldest();
    }
  }

  /**
   * Get cached URL for a VK audio track.
   * Returns undefined if not found or TTL expired.
   */
  get(ownerId: string, audioId: string): string | undefined {
    const key = `${ownerId}:${audioId}`;
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.url;
  }

  /** Current number of entries in cache */
  size(): number {
    return this.entries.size;
  }

  /** Finds and removes the entry with the smallest timestamp. */
  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;

    for (const [key, entry] of this.entries) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}
