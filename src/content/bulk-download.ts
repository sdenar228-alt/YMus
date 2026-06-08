/**
 * Module: bulk-download
 *
 * Чистая логика группового скачивания треков (resolve → confirm → loop → notify),
 * не привязанная к конкретной DOM-обёртке кнопки. UI-обёртка
 * (`playlist-header-button.ts`) подключает контроллер из этого модуля.
 *
 * Этот файл реализует ТОЛЬКО:
 *  - публичные типы (`ResolveResult`, `BulkDownloadConfig`, `BulkDownloadCallbacks`,
 *    `BulkDownloadController`, `BulkDownloadResult`, `BulkDownloadProgress`);
 *  - внутреннюю функцию `resolveTrackIds()` — стратегия API → DOM с таймаутом;
 *  - вспомогательную `scrapeTrackIdsFromDom()` — fallback по DOM-ссылкам.
 *
 * Контроллер `createBulkDownload(...)` (confirm / последовательный цикл / прогресс /
 * итоговый notify) добавляется в task 5.2.
 *
 * См. design.md → "Components and Interfaces" / "Data Models" /
 * Property 7 (резолв реализует приоритет API > DOM) и Requirements 5.1, 5.9.
 */

import { detectListPageKind, findPlaylistHeader } from "./playlist-header-finder";
import { sanitizeFolderName } from "../shared/folder-sanitizer";

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Результат разрешения списка трек-идентификаторов для текущей страницы.
 *
 * @property ids    — упорядоченный список trackId без дубликатов (строки цифр).
 * @property source — какая стратегия дала результат:
 *                    "API" — ответ Service_Worker на `RESOLVE_ALBUM`/`RESOLVE_PLAYLIST`,
 *                    "DOM" — fallback, сбор `/track/{id}` со страницы.
 * @property title  — название плейлиста/альбома из API-ответа; `null` при DOM-fallback.
 */
export interface ResolveResult {
  readonly ids: readonly string[];
  readonly source: "API" | "DOM";
  readonly title: string | null;
}

/**
 * Параметры контроллера группового скачивания. Все поля опциональны —
 * см. {@link DEFAULT_BULK_DOWNLOAD_CONFIG} для значений по умолчанию.
 */
export interface BulkDownloadConfig {
  /**
   * Минимальная пауза между запусками скачиваний, мс.
   * Допустимый диапазон: 800–2000 (Requirement 5.5).
   * По умолчанию 800.
   */
  readonly intervalMs: number;
  /**
   * Тайм-аут ответа Service_Worker на `RESOLVE_ALBUM`/`RESOLVE_PLAYLIST`, мс.
   * По умолчанию 10000 (Requirement 5.1).
   */
  readonly resolveTimeoutMs: number;
  /**
   * Максимальный размер списка треков, при котором запускается цикл (Requirement 5.3).
   * По умолчанию 1000.
   */
  readonly maxTracks: number;
  /**
   * Внешний резолвер, подменяющий `resolveTrackIds()`. Опционально.
   *
   * Когда задан, `createBulkDownload(...).start()` вызывает его вместо
   * дефолтного `resolveTrackIds(resolveTimeoutMs)`. Используется в
   * `bulk-trigger.ts` для резолва по конкретному Album_Identifier.
   */
  readonly resolve?: () => Promise<ResolveResult>;
}

/**
 * Колбэки, через которые контроллер взаимодействует с UI-обёрткой кнопки.
 * Все вызовы происходят синхронно из реализации `start()`.
 */
export interface BulkDownloadCallbacks {
  /** Перевести кнопку в состояние «идёт скачивание {done}/{total}». */
  onProgress(done: number, total: number): void;
  /** Вернуть кнопку в исходное idle-состояние («Скачать плейлист», `disabled=false`). */
  onIdle(): void;
  /** Показать пользователю сообщение/уведомление через UI-toast. */
  notify(text: string, kind: "success" | "error" | "info"): void;
  /** Запросить у пользователя модальное подтверждение перед стартом цикла. */
  confirm(message: string): boolean;
}

/**
 * Публичный интерфейс контроллера группового скачивания.
 * Реализация — `createBulkDownload(...)` (task 5.2).
 */
export interface BulkDownloadController {
  /** Пользователь нажал кнопку — запустить групповое скачивание. */
  start(): Promise<void>;
  /** Принудительно сбросить состояние (например, при SPA-навигации). */
  reset(): void;
  /** Признак активного цикла (между confirm и финальным notify). */
  isRunning(): boolean;
}

/**
 * Снимок прогресса в момент очередного `onProgress`-вызова.
 * `done === succeeded + failed` всегда.
 */
export interface BulkDownloadProgress {
  readonly done: number;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Итог завершённого (или отменённого) группового скачивания.
 * `succeeded + failed === total` если `cancelled === false`.
 */
export interface BulkDownloadResult {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly cancelled: boolean;
}

/** Значения по умолчанию для {@link BulkDownloadConfig}. */
export const DEFAULT_BULK_DOWNLOAD_CONFIG: BulkDownloadConfig = {
  intervalMs: 800,
  resolveTimeoutMs: 10000,
  maxTracks: 1000,
};

// ─── Service Worker response shapes ───────────────────────────────────────────
//
// Совпадают с ответами `RESOLVE_ALBUM` / `RESOLVE_PLAYLIST` из
// `src/background/message-router.ts`. Дублируем здесь, чтобы content_script
// не зависел от приватных типов SW.

interface ResolveAlbumResponse {
  success: boolean;
  album?: { albumId: string; title: string; trackIds: string[] };
  reason?: string;
}

interface ResolvePlaylistResponse {
  success: boolean;
  playlist?: {
    owner: string;
    kind: string;
    title: string;
    trackIds: string[];
  };
  reason?: string;
}

type ResolveResponse = ResolveAlbumResponse | ResolvePlaylistResponse;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Собирает уникальные `trackId` из всех ссылок вида `/track/{id}` в текущем DOM.
 *
 * Используется как fallback к API-стратегии и сам по себе для страниц,
 * на которых API-резолв не определён (например, чарт без явного резолвера).
 *
 * Контракт:
 *  - идентификаторы извлекаются регексом `\/track\/(\d+)` из атрибута `href`
 *    (поддерживает оба варианта: `/track/{id}` и `/album/{x}/track/{id}`);
 *  - порядок результата соответствует порядку первого вхождения `id` в DOM;
 *  - повторы удаляются через `Set`.
 *
 * @returns Список `trackId` (строки цифр) без дубликатов.
 */
export function scrapeTrackIdsFromDom(): readonly string[] {
  const seen = new Set<string>();
  const links = document.querySelectorAll('a[href*="/track/"]');
  for (const a of Array.from(links)) {
    const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
    const m = href.match(/\/track\/(\d+)/);
    if (m !== null) {
      seen.add(m[1]);
    }
  }
  return Array.from(seen);
}

/**
 * Соответствие `ListPageKind` → тип сообщения резолвера в Service_Worker.
 * `none` и `track` не резолвятся через API (на них групповое скачивание
 * не применимо в принципе).
 */
function pickResolveMessageType(
  kind: ReturnType<typeof detectListPageKind>,
): "RESOLVE_ALBUM" | "RESOLVE_PLAYLIST" | null {
  switch (kind) {
    case "album":
      return "RESOLVE_ALBUM";
    case "playlist-classic":
    case "playlist-uuid":
    case "likes":
    case "chart":
      return "RESOLVE_PLAYLIST";
    case "track":
    case "none":
    default:
      return null;
  }
}

/** Результат успешного API-резолва: список trackId и название. */
interface ApiResolveResult {
  readonly trackIds: readonly string[];
  readonly title: string | null;
}

/**
 * Запрос к Service_Worker с тайм-аутом.
 *
 * Реализуется через `Promise.race`: первый из двух промисов «резолв ответа SW»
 * и «таймер `timeoutMs` мс» определяет результат. При тайм-ауте, отсутствии
 * ответа, ошибке `sendMessage` или `success === false` функция возвращает `null`,
 * чтобы вызывающий мог откатиться на DOM-fallback.
 */
async function resolveTrackIdsViaApi(
  messageType: "RESOLVE_ALBUM" | "RESOLVE_PLAYLIST",
  timeoutMs: number,
): Promise<ApiResolveResult | null> {
  if (typeof chrome === "undefined" || chrome.runtime?.id === undefined) {
    return null;
  }

  const sendPromise: Promise<ApiResolveResult | null> = (async () => {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: messageType,
        payload: { input: location.href },
      })) as ResolveResponse | undefined;
      if (response === undefined || !response.success) return null;
      if ("album" in response && response.album !== undefined) {
        return {
          trackIds: response.album.trackIds,
          title: response.album.title || null,
        };
      }
      if ("playlist" in response && response.playlist !== undefined) {
        return {
          trackIds: response.playlist.trackIds,
          title: response.playlist.title || null,
        };
      }
      return null;
    } catch {
      return null;
    }
  })();

  const timeoutPromise = new Promise<null>((resolve) => {
    window.setTimeout(() => resolve(null), timeoutMs);
  });

  return Promise.race([sendPromise, timeoutPromise]);
}

/**
 * Разрешает список `trackId` для текущей Страницы_Списка_Треков по стратегии
 * API → DOM.
 *
 * Алгоритм (Requirements 5.1, 5.9; Property 7):
 *  1. Определяется тип страницы через `detectListPageKind(location.pathname)`.
 *  2. Если тип ∈ `{album, playlist-classic, playlist-uuid, likes, chart}` —
 *     отправляется `RESOLVE_ALBUM` (для `album`) или `RESOLVE_PLAYLIST` (для
 *     остальных) в Service_Worker. Ответ ожидается не дольше `resolveTimeoutMs`
 *     (по умолчанию 10000 мс) через `Promise.race`. При непустом списке от SW —
 *     возвращается `{ ids, source: "API" }`.
 *  3. Иначе (включая случай, когда API ответил пустым/ошибкой/таймаутом) —
 *     выполняется `scrapeTrackIdsFromDom()`. При непустом результате —
 *     возвращается `{ ids, source: "DOM" }`.
 *  4. Если оба источника пустые — выбрасывается `Error("Треки не найдены")`.
 *
 * Контроллер `createBulkDownload(...)` (task 5.2) ловит ошибку и преобразует
 * её в `notify("Треки не найдены", "error")` (Requirement 5.2).
 *
 * @param resolveTimeoutMs - тайм-аут ответа SW; по умолчанию 10000 мс.
 * @returns `ResolveResult` с непустым списком `ids`.
 * @throws Error если ни API, ни DOM не дали ни одного идентификатора.
 */
export async function resolveTrackIds(
  resolveTimeoutMs: number = DEFAULT_BULK_DOWNLOAD_CONFIG.resolveTimeoutMs,
): Promise<ResolveResult> {
  const kind = detectListPageKind(location.pathname);
  const messageType = pickResolveMessageType(kind);

  if (messageType !== null) {
    const apiResult = await resolveTrackIdsViaApi(messageType, resolveTimeoutMs);
    if (apiResult !== null && apiResult.trackIds.length > 0) {
      return { ids: apiResult.trackIds, source: "API", title: apiResult.title };
    }
  }

  const domIds = scrapeTrackIdsFromDom();
  if (domIds.length > 0) {
    return { ids: domIds, source: "DOM", title: null };
  }

  throw new Error("Треки не найдены");
}

// ─── Controller (createBulkDownload) ──────────────────────────────────────────

import { downloadTrackWithTags } from "./downloader";

/** Минимальная допустимая пауза между запусками скачиваний (Requirement 5.5). */
const MIN_INTERVAL_MS = 800;
/** Максимальная допустимая пауза между запусками скачиваний (Requirement 5.5). */
const MAX_INTERVAL_MS = 2000;

/**
 * Форматирует количество секунд в строку вида `"M:SS"`.
 *
 * Минуты не дополняются ведущим нулём, секунды — всегда двумя цифрами
 * (Requirement 5.3, design Property 9).
 *
 * Примеры:
 *  -   5 → `"0:05"`
 *  -  65 → `"1:05"`
 *  - 600 → `"10:00"`
 */
function formatEta(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Слияние пользовательской конфигурации с дефолтами + клампинг `intervalMs`. */
function resolveConfig(
  overrides?: Partial<BulkDownloadConfig>,
): BulkDownloadConfig {
  const merged = { ...DEFAULT_BULK_DOWNLOAD_CONFIG, ...overrides };
  const clampedInterval = Math.max(
    MIN_INTERVAL_MS,
    Math.min(MAX_INTERVAL_MS, merged.intervalMs),
  );
  return { ...merged, intervalMs: clampedInterval };
}

/** Промис-задержка на `ms` миллисекунд через `window.setTimeout`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * Создаёт контроллер группового скачивания треков.
 *
 * Контроллер инкапсулирует весь сценарий «resolve → confirm → loop → notify»
 * и общается с UI-обёрткой только через {@link BulkDownloadCallbacks}, что
 * позволяет переиспользовать логику из любой реализации кнопки.
 *
 * Поведение `start()` (Requirements 5.1–5.9):
 *  1. Защита от повторного входа: если `isRunning()` уже `true`, вызов
 *     немедленно возвращает управление.
 *  2. Резолв списка `trackId` через {@link resolveTrackIds}. При ошибке
 *     или пустом списке — `notify("Треки не найдены", "error")`,
 *     `onIdle()`, выход.
 *  3. Показ модального подтверждения с количеством треков и ETA в формате
 *     `M:SS`. ETA вычисляется как `Math.ceil(count * intervalMs / 1000)` секунд.
 *  4. При отмене — `onIdle()`, выход (без `notify`).
 *  5. Последовательный цикл: для каждого `id` вызывается
 *     {@link downloadTrackWithTags}, исход (success/fail) накапливается в
 *     счётчики, после каждого трека — `onProgress(done, total)`. Между
 *     соседними треками — пауза `intervalMs`. Ошибки одного трека ловятся
 *     `try/catch` и не прерывают цикл (Requirement 5.7).
 *  6. По завершении — ровно один `notify(...)` с целыми `succeeded`/`failed`.
 *     `kind === "success"` если `failed === 0`, иначе `"error"`.
 *  7. В `finally` — `onIdle()`, сброс внутреннего `running`-флага.
 *
 * Поведение `reset()`: flips внутренний `cancelled`-флаг. Цикл проверяет его
 * перед началом каждой итерации и аккуратно выходит. Текущее in-flight
 * скачивание НЕ прерывается — это «best-effort» отмена для случаев SPA-
 * навигации со страницы списка.
 *
 * @param callbacks - колбэки UI-обёртки.
 * @param config    - частичные переопределения конфигурации.
 * @returns Контроллер с методами `start()`, `reset()`, `isRunning()`.
 */
export function createBulkDownload(
  callbacks: BulkDownloadCallbacks,
  config?: Partial<BulkDownloadConfig>,
): BulkDownloadController {
  const cfg = resolveConfig(config);
  let running = false;
  let cancelled = false;

  async function start(): Promise<void> {
    if (running) return;
    running = true;
    cancelled = false;

    try {
      // 1. Резолв списка trackId.
      let resolved: ResolveResult;
      try {
        resolved = cfg.resolve !== undefined
          ? await cfg.resolve()
          : await resolveTrackIds(cfg.resolveTimeoutMs);
      } catch {
        callbacks.notify("Треки не найдены", "error");
        return;
      }

      const ids = resolved.ids;
      const total = ids.length;
      if (total === 0) {
        callbacks.notify("Треки не найдены", "error");
        return;
      }

      // 1b. Определение folderName (Requirements 7.1–7.6, 1.3–1.5).
      let rawTitle: string | null = null;
      if (resolved.source === "API") {
        rawTitle = resolved.title;
      } else {
        // DOM-fallback: извлечь textContent из заголовка страницы.
        const header = findPlaylistHeader();
        if (header !== null) {
          rawTitle = (header.titleElement.textContent ?? "").trim() || null;
        }
      }

      // Fallback: если title пустой/null — "Playlist" или "Album" по типу страницы.
      if (rawTitle === null || rawTitle.trim().length === 0) {
        const kind = detectListPageKind(location.pathname);
        rawTitle = kind === "album" ? "Album" : "Playlist";
      }

      const folderName = sanitizeFolderName(rawTitle);

      // If only 1 track (single), skip folder — download as single track
      const effectiveFolder = total === 1 ? undefined : folderName;

      // 2. Подтверждение с ETA (skip for single tracks — no need to confirm).
      if (total > 1) {
        const etaSeconds = Math.ceil((total * cfg.intervalMs) / 1000);
        const eta = formatEta(etaSeconds);
        const confirmed = callbacks.confirm(
          `Скачать ${total} треков?\nЗагрузка займёт примерно ${eta}.`,
        );
        if (!confirmed) {
          return;
        }
      }

      // 3. Последовательный цикл. Перед первой итерацией сообщаем UI
      //    о переходе в running-состояние (disabled=true, "Скачивание 0/N").
      let succeeded = 0;
      let failed = 0;
      callbacks.onProgress(0, total);
      for (let i = 0; i < total; i++) {
        if (cancelled) break;
        const id = ids[i];
        try {
          const result = await downloadTrackWithTags(id, undefined, effectiveFolder);
          if (result.success) {
            succeeded++;
          } else {
            failed++;
            console.warn(
              `[ymd][bulk] track ${id} failed: ${result.reason ?? "unknown"}`,
            );
          }
        } catch (e) {
          failed++;
          console.warn(`[ymd][bulk] track ${id} threw:`, e);
        }
        callbacks.onProgress(succeeded + failed, total);
        // Пауза перед следующим треком; после последнего пауза не нужна.
        if (i < total - 1 && !cancelled) {
          await sleep(cfg.intervalMs);
        }
      }

      // 4. Итоговое уведомление.
      // При полном успехе toast не показываем — кнопка вернётся в idle,
      // этого достаточно как визуального фидбэка. Notify только при ошибках,
      // чтобы пользователь узнал, что часть треков не скачалась.
      if (failed > 0) {
        callbacks.notify(
          `Готово: успешно ${succeeded}, ошибок ${failed}`,
          "error",
        );
      }
    } finally {
      running = false;
      cancelled = false;
      callbacks.onIdle();
    }
  }

  function reset(): void {
    cancelled = true;
  }

  function isRunning(): boolean {
    return running;
  }

  return { start, reset, isRunning };
}
