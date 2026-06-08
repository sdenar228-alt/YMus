// URLCache — кэш Download_URL по trackId с LRU-вытеснением по timestamp.
//
// Поведение `set`:
//   • если для того же `trackId` уже есть запись с большим или равным
//     `bitrateInKbps`, новая запись игнорируется (выбирается лучшее качество);
//   • иначе запись добавляется/обновляется;
//   • при превышении лимита `MAX_ENTRIES` вытесняется запись с наименьшим
//     `timestamp` (наиболее старая).

import type { CacheEntry } from "../shared/types.js";

const MAX_ENTRIES = 50;

export class URLCache {
  private readonly entries = new Map<string, CacheEntry>();

  /**
   * Добавляет или обновляет запись.
   *
   * Если для того же `trackId` уже есть запись с большим или равным
   * битрейтом — обновление не выполняется. После добавления, если размер
   * кэша превысил лимит, вытесняется запись с наименьшим `timestamp`.
   */
  set(entry: CacheEntry): void {
    const existing = this.entries.get(entry.trackId);
    if (existing !== undefined && entry.bitrateInKbps < existing.bitrateInKbps) {
      return;
    }

    this.entries.set(entry.trackId, entry);

    if (this.entries.size > MAX_ENTRIES) {
      this.evictOldest();
    }
  }

  /** Возвращает запись по `trackId` или `undefined`, если её нет. */
  get(trackId: string): CacheEntry | undefined {
    return this.entries.get(trackId);
  }

  /** Удаляет запись по `trackId`. Если записи нет — операция no-op. */
  delete(trackId: string): void {
    this.entries.delete(trackId);
  }

  /** Текущее количество записей в кэше. */
  size(): number {
    return this.entries.size;
  }

  /** Находит и удаляет запись с наименьшим `timestamp`. */
  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTimestamp = Number.POSITIVE_INFINITY;

    for (const [trackId, entry] of this.entries) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = trackId;
      }
    }

    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}
