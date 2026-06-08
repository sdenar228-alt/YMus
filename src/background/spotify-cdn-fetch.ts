// Стрим-fetch зашифрованного Ogg-файла с CDN Spotify.
// Реализует Requirements 7.3–7.6, 7.8, 7.9, 21.5, 21.7
// (см. requirements.md, design § C «spotify-cdn-fetch.ts»).
//
// Особенности этого шага по сравнению с REST-эндпоинтами Spotify:
//
//  1. Тело ответа — большой бинарный блок, а не маленький JSON. Поэтому
//     читаем потоком через `response.body.getReader()` и параллельно
//     репортим прогресс в content script.
//  2. Двойной таймер (R21.5):
//       * общий тайм-аут 30 000 мс — ограничивает суммарную длительность
//         скачивания вне зависимости от числа байт;
//       * inter-byte stall 15 000 мс — таймер, сбрасываемый на каждом
//         прочитанном chunk; срабатывает, если CDN перестал слать байты,
//         даже если общий лимит ещё не достигнут.
//     По любому из двух таймаутов — `controller.abort()` + бросок
//     `SpotifyError("SPOTIFY_CDN_FETCH_FAILED", "Превышено время скачивания")`
//     (R21.7).
//  3. Маппинг HTTP-кодов:
//       * 200 / 206 — успех;
//       * 401 / 403 — `invalidateSpotifyToken()` + `SPOTIFY_TOKEN_EXPIRED`
//         (R7.9, R4.5);
//       * прочее — `SPOTIFY_CDN_FETCH_FAILED` с включением статуса в
//         `reason` (R7.8).
//  4. Сетевая ошибка fetch (TypeError, network failure и т.п.) — мапится
//     в `SPOTIFY_CDN_FETCH_FAILED` с текстом исключения в `reason`.

import { SpotifyError } from "./spotify-errors";
import { invalidateSpotifyToken } from "./spotify-token-capture";

// ─── Константы (R21.5) ─────────────────────────────────────────────────────

/** Общий лимит длительности CDN-fetch (R21.5). */
const CDN_OVERALL_TIMEOUT_MS = 30_000;

/** Лимит «тишины» от CDN между чанками (R21.5). */
const CDN_INTER_BYTE_TIMEOUT_MS = 15_000;

/** Минимальный интервал между вызовами onProgress (R7.5). */
const PROGRESS_THROTTLE_MS = 200;

// ─── Типы публичного API ───────────────────────────────────────────────────

/**
 * Колбэк прогресса CDN-fetch.
 *
 * `percent`: целое число `0..100`, либо `null`, если CDN не отдал
 * `Content-Length` (R7.6 — индетерминированный heartbeat).
 *
 * `downloadedBytes`: суммарный объём скачанного к моменту вызова.
 * Полезен оркестратору, чтобы при `percent === null` показывать
 * пользователю хотя бы бегущую анимацию «качается X КБ».
 */
export type CdnProgressCallback = (
  percent: number | null,
  downloadedBytes: number,
) => void;

/**
 * Результат `fetchEncryptedFile`.
 *
 * `expectedLength` — `Content-Length` оригинального ответа CDN до снятия
 * Spotify-Vorbis-префикса (R7.4); используется в `validateDecryption`
 * (см. spotify-aes-decrypt.ts § validateDecryption и design § K).
 */
export interface FetchEncryptedFileResult {
  bytes: Uint8Array;
  expectedLength: number | null;
}

// ─── Внутренние утилиты ────────────────────────────────────────────────────

/**
 * Парсит и валидирует `Content-Length`. Любые «странные» значения
 * (отрицательные, нечисловые, отсутствующие) трактуются как «нет
 * длины» — `null` (R7.6).
 */
function parseContentLength(headers: Headers): number | null {
  const raw = headers.get("Content-Length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Безопасный вызов колбэка прогресса. Любая ошибка внутри `onProgress`
 * не должна приводить к падению пайплайна скачивания — поэтому глушим
 * её здесь.
 */
function safeProgress(
  cb: CdnProgressCallback,
  percent: number | null,
  downloaded: number,
): void {
  try {
    cb(percent, downloaded);
  } catch {
    // намеренно игнорируем — диагностика прогресса не критична
  }
}

// ─── Публичный API ─────────────────────────────────────────────────────────

/**
 * Скачивает зашифрованный Ogg-файл с CDN Spotify в стрим-режиме с
 * двойным таймером и репортом прогресса (R7.3–7.6, R7.8, R7.9, R21.5,
 * R21.7).
 *
 * @param cdnUrl Полный URL, полученный из `storage-resolve`.
 * @param token  Spotify_Access_Token; передаётся в заголовок
 *   `Authorization: Bearer …`. Заголовок добавляется даже на CDN: часть
 *   региональных эджей Spotify требует его, часть игнорирует, поэтому
 *   безопасный путь — слать всегда.
 * @param onProgress Колбэк прогресса (см. {@link CdnProgressCallback}).
 *   Вызывается не реже одного раза в 200 мс на основе накопленного
 *   объёма; первый вызов — сразу после установления соединения с
 *   нулевым прогрессом, последний — со 100% (или `null`).
 * @param externalSignal Опциональный сигнал отмены извне (например,
 *   общий тайм-аут оркестратора). При его срабатывании запрос
 *   прерывается; ошибка пробрасывается «как есть», чтобы оркестратор
 *   мог отличить внешний абор от внутреннего таймаута и пометить
 *   правильную стадию.
 *
 * @throws {SpotifyError} `SPOTIFY_TOKEN_EXPIRED` на 401 / 403 (R7.9).
 * @throws {SpotifyError} `SPOTIFY_CDN_FETCH_FAILED` на любой другой
 *   ошибке: не-2xx статус ≠ 200/206, сетевая ошибка, общий или
 *   inter-byte таймаут (R7.8, R21.7).
 */
export async function fetchEncryptedFile(
  cdnUrl: string,
  token: string,
  onProgress: CdnProgressCallback,
  externalSignal?: AbortSignal,
): Promise<FetchEncryptedFileResult> {
  const controller = new AbortController();

  // Различаем причину аборта в catch: внутренний таймаут vs внешний
  // сигнал. Оба ставят controller.abort(), но для маппинга ошибок
  // нам нужно знать, кто стрельнул первым.
  let internalTimeout = false;

  // ── Внешний сигнал → проксируем в наш controller ─────────────────────
  const onExternalAbort = (): void => {
    // НЕ помечаем internalTimeout: это не наша вина, оркестратор сам
    // решит, как классифицировать собственный abort.
    controller.abort();
  };
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  // ── Двойной таймер (R21.5) ───────────────────────────────────────────
  // Общий — ставится один раз и не сбрасывается.
  const overallTimer = setTimeout(() => {
    internalTimeout = true;
    controller.abort();
  }, CDN_OVERALL_TIMEOUT_MS);

  // Inter-byte — пересоздаётся на каждом прочитанном chunk.
  let interByteTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshInterByteTimer = (): void => {
    if (interByteTimer !== null) clearTimeout(interByteTimer);
    interByteTimer = setTimeout(() => {
      internalTimeout = true;
      controller.abort();
    }, CDN_INTER_BYTE_TIMEOUT_MS);
  };

  try {
    // Сам fetch: один полный GET без Range (Q3 в design § Edge Cases).
    const response = await fetch(cdnUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    // 401 / 403 — токен протух или вкладка вышла из авторизованной
    // сессии (R7.9, R4.5). Инвалидируем кеш, чтобы следующий запуск
    // пайплайна автоматически дождался свежего перехвата.
    if (response.status === 401 || response.status === 403) {
      invalidateSpotifyToken();
      throw new SpotifyError(
        "SPOTIFY_TOKEN_EXPIRED",
        `CDN ответил HTTP ${response.status}`,
      );
    }

    // Любой статус, отличный от 200/206, — ошибка CDN (R7.8).
    if (response.status !== 200 && response.status !== 206) {
      throw new SpotifyError(
        "SPOTIFY_CDN_FETCH_FAILED",
        `CDN ответил HTTP ${response.status}`,
      );
    }

    const expectedLength = parseContentLength(response.headers);

    // Без тела ничего разумного отдать не можем — это аномалия CDN.
    if (response.body === null) {
      throw new SpotifyError(
        "SPOTIFY_CDN_FETCH_FAILED",
        "CDN вернул пустое тело ответа",
      );
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let downloaded = 0;
    let lastProgressAt = 0;

    // Стартовый тик inter-byte таймера: с момента, когда мы начали
    // ждать первый chunk.
    refreshInterByteTimer();

    // Первый репорт прогресса — нулевой (даёт UI понять, что всё
    // началось, даже если первый chunk придёт через сотни мс).
    safeProgress(onProgress, expectedLength !== null ? 0 : null, 0);

    // Основной цикл чтения: читаем чанки до done=true, на каждом
    // чанке сбрасываем inter-byte таймер и (с тротлингом 200 мс)
    // отправляем прогресс.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      if (value !== undefined && value.byteLength > 0) {
        chunks.push(value);
        downloaded += value.byteLength;
        refreshInterByteTimer();

        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
          lastProgressAt = now;
          let percent: number | null;
          if (expectedLength !== null && expectedLength > 0) {
            // Math.floor + ограничение сверху на 100 — иначе
            // несовпадение Content-Length и реального тела даст 101%
            // и сломает прогрессбар (см. R7.5).
            const raw = Math.floor((downloaded / expectedLength) * 100);
            percent = raw > 100 ? 100 : raw;
          } else {
            percent = null;
          }
          safeProgress(onProgress, percent, downloaded);
        }
      }
    }

    // Финальный репорт: гарантирует, что UI получит «100%» даже если
    // последний chunk попал внутрь 200-мс окна тротлинга.
    safeProgress(onProgress, expectedLength !== null ? 100 : null, downloaded);

    // Склеивание чанков в один непрерывный буфер. Делается прямо здесь
    // (а не лениво), чтобы AES-decrypt мог принять Uint8Array целиком.
    const bytes = new Uint8Array(downloaded);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }

    return { bytes, expectedLength };
  } catch (e) {
    // SpotifyError, выброшенный нами выше, проходит без обёртывания.
    if (e instanceof SpotifyError) throw e;

    // Внутренний таймаут (общий или inter-byte) — фиксированное
    // сообщение из R21.7.
    if (internalTimeout) {
      throw new SpotifyError(
        "SPOTIFY_CDN_FETCH_FAILED",
        "Превышено время скачивания",
      );
    }

    // Внешний абор — не наш «таймаут CDN», пробрасываем оригинальное
    // исключение, чтобы оркестратор мог корректно классифицировать
    // его как абор стадии CDN-fetch (см. spotify-download-handler.ts).
    if (externalSignal !== undefined && externalSignal.aborted) {
      throw e;
    }

    // Прочее — сетевая ошибка fetch / reader.read() (R7.8).
    const message = e instanceof Error ? e.message : String(e);
    throw new SpotifyError(
      "SPOTIFY_CDN_FETCH_FAILED",
      `Сетевая ошибка CDN: ${message}`,
    );
  } finally {
    clearTimeout(overallTimer);
    if (interByteTimer !== null) clearTimeout(interByteTimer);
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
