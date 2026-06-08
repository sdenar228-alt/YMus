/**
 * Module: bulk-trigger
 *
 * Общий триггер массового скачивания по Album_Identifier.
 * Используется Cover_Hover_Button и Carousel_Card_Button.
 *
 * Алгоритм:
 *   1. Pre-flight: offline → toast + onIdle + inert handle.
 *   2. Pre-flight: chrome.runtime?.id === undefined → toast + inert handle.
 *   3. Построение messageType + payload.input из identifier.
 *   4. Race sendMessage vs timeout (resolveTimeoutMs, default 10000).
 *   5. На AUTH_REQUIRED / NETWORK_ERROR → toast + onIdle.
 *   6. На timeout → fallback scrapeTrackIdsFromDom(); если пусто → toast.
 *   7. На empty trackIds → toast + onIdle.
 *   8. На non-empty → createBulkDownload с resolve, start().
 *
 * Requirements: 2.5, 2.6, 2.7, 3.5, 3.6, 6.7, 7.1, 7.2, 7.3, 7.4, 7.6,
 *               11.2, 11.3, 11.4
 */

import type { CardIdentifier } from "./card-classifier";
import { buildAlbumIdentifierUrl } from "./card-classifier";
import {
  createBulkDownload,
  scrapeTrackIdsFromDom,
  type BulkDownloadCallbacks,
  type BulkDownloadConfig,
  type ResolveResult,
} from "./bulk-download";

// ─── Public types ────────────────────────────────────────────────────────────

export interface BulkTriggerArgs {
  /** Идентификатор альбома/плейлиста для резолва. */
  identifier: NonNullable<CardIdentifier>;
  /** Колбэки для взаимодействия с UI-обёрткой кнопки. */
  callbacks: BulkDownloadCallbacks;
  /** Опциональные переопределения интервала/maxTracks. */
  config?: Partial<BulkDownloadConfig>;
  /** Тайм-аут резолва от Service_Worker. По умолчанию 10000 мс (Req 2.6). */
  resolveTimeoutMs?: number;
}

export interface BulkTriggerHandle {
  /** true пока идёт резолв или цикл скачивания. */
  isRunning(): boolean;
  /** Best-effort отмена (флаг проверяется перед каждой итерацией). */
  cancel(): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Человекочитаемое сообщение для ошибки авторизации. */
function userMessageForError(reason?: string): string {
  return reason ?? "Требуется авторизация";
}

/** Тайм-аут по умолчанию для ожидания ответа SW. */
const DEFAULT_RESOLVE_TIMEOUT_MS = 10_000;

/** Форма ответа SW на RESOLVE_ALBUM / RESOLVE_PLAYLIST. */
interface SwResolveResponse {
  success: boolean;
  album?: { albumId: string; title: string; trackIds: string[] };
  playlist?: { owner: string; kind: string; title: string; trackIds: string[] };
  reason?: string;
  errorCode?: string;
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * Запускает массовое скачивание для одного Album_Identifier.
 *
 * Возвращает handle для cancel-а. Промис не пробрасывается наружу —
 * UI в курсе через onProgress/onIdle колбэки.
 */
export function startBulkTrigger(args: BulkTriggerArgs): BulkTriggerHandle {
  const { identifier, callbacks, config, resolveTimeoutMs } = args;
  const timeoutMs = resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;

  let running = false;
  let cancelled = false;

  // Inert handle used for early-exit paths.
  const inertHandle: BulkTriggerHandle = {
    isRunning: () => running,
    cancel: () => { cancelled = true; },
  };

  // ─── Pre-flight checks ───────────────────────────────────────────────────

  // Req 7.2: Offline check
  if (!navigator.onLine) {
    callbacks.notify("Нет подключения к интернету", "error");
    callbacks.onIdle();
    return inertHandle;
  }

  // Req 7.6: Extension runtime lost
  if (typeof chrome === "undefined" || chrome.runtime?.id === undefined) {
    callbacks.notify(
      "Расширение обновлено. Перезагрузите эту страницу (F5).",
      "error",
    );
    return inertHandle;
  }

  // ─── Async trigger (fire-and-forget from caller's perspective) ────────────

  running = true;

  void (async () => {
    try {
      if (cancelled) return;

      // Build message type and payload URL.
      const messageType: "RESOLVE_ALBUM" | "RESOLVE_PLAYLIST" =
        identifier.kind === "album" ? "RESOLVE_ALBUM" : "RESOLVE_PLAYLIST";
      const inputUrl = buildAlbumIdentifierUrl(identifier);

      // Race sendMessage against timeout (Req 2.6).
      let response: SwResolveResponse | null = null;
      let timedOut = false;

      const sendPromise = (async (): Promise<SwResolveResponse | null> => {
        try {
          const r = await chrome.runtime.sendMessage({
            type: messageType,
            payload: { input: inputUrl },
          });
          return (r as SwResolveResponse) ?? null;
        } catch {
          return null;
        }
      })();

      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, timeoutMs);
      });

      response = await Promise.race([sendPromise, timeoutPromise]);

      if (cancelled) return;

      // ─── Handle AUTH_REQUIRED (Req 7.4) ─────────────────────────────────
      if (response !== null && response.errorCode === "AUTH_REQUIRED") {
        callbacks.notify(userMessageForError(response.reason), "error");
        callbacks.onIdle();
        return;
      }

      // ─── Handle NETWORK_ERROR (Req 7.3) ────────────────────────────────
      if (response !== null && response.errorCode === "NETWORK_ERROR") {
        callbacks.notify("Ошибка сети", "error");
        callbacks.onIdle();
        return;
      }

      // ─── Extract trackIds from successful response ──────────────────────
      let trackIds: readonly string[] = [];
      let title: string | null = null;

      if (response !== null && response.success) {
        if (response.album !== undefined) {
          trackIds = response.album.trackIds;
          title = response.album.title || null;
        } else if (response.playlist !== undefined) {
          trackIds = response.playlist.trackIds;
          title = response.playlist.title || null;
        }
      }

      // ─── Timeout fallback to DOM scraping (Req 6.7) ─────────────────────
      if (trackIds.length === 0 && timedOut) {
        const domIds = scrapeTrackIdsFromDom();
        if (domIds.length > 0) {
          trackIds = domIds;
          title = null;
        }
      }

      // ─── Empty trackIds → toast (Req 6.7, 2.6) ─────────────────────────
      if (trackIds.length === 0) {
        callbacks.notify("Треки не найдены", "error");
        callbacks.onIdle();
        return;
      }

      if (cancelled) return;

      // ─── Start bulk download cycle (Req 11.2) ──────────────────────────
      const ids = trackIds;
      const resolveResult: ResolveResult = {
        ids,
        source: "API",
        title,
      };

      const controller = createBulkDownload(callbacks, {
        ...config,
        resolve: () => Promise.resolve(resolveResult),
      });

      // Wire cancel flag into controller reset.
      const origCancel = inertHandle.cancel;
      inertHandle.cancel = () => {
        cancelled = true;
        controller.reset();
      };

      await controller.start();
    } catch (e) {
      // Unexpected error — surface generic message and return to idle.
      console.error("[ymd][bulk-trigger] unexpected error:", e);
      callbacks.notify("Неизвестная ошибка", "error");
      callbacks.onIdle();
    } finally {
      running = false;
    }
  })();

  return inertHandle;
}
