// Клиент эндпоинта Spotify `audio-keys` — получение 16-байтового
// AES-128-ключа расшифровки конкретной пары (Spotify_File_Id, Track_GID).
//
// Реализует Requirements 8.1–8.6, 21.4, 21.6 (см. requirements.md);
// общая схема — design.md § Pipeline (шаг 7) и § F (parallelism).
//
// Особенность этого эндпоинта по сравнению с остальными Spotify-эндпоинтами
// (см. design § L таблицу error taxonomy):
//   * HTTP 401 → SPOTIFY_TOKEN_EXPIRED + invalidateSpotifyToken();
//   * HTTP 403 → SPOTIFY_DRM_PROTECTED, БЕЗ инвалидации токена.
// На остальных эндпоинтах (api.spotify.com, metadata, storage-resolve, CDN)
// 403 интерпретируется как протухший токен; здесь — нет, потому что Spotify
// возвращает 403 от audio-keys именно при отсутствии прав на расшифровку
// (DRM-защищённый трек).

import { SpotifyError } from "./spotify-errors";
import {
  getSpotifyClientToken,
  getSpotifySpclientHost,
  invalidateSpotifyToken,
} from "./spotify-token-capture";

/**
 * Тайм-аут одного запроса к audio-keys (R21.4).
 * 5 секунд — типичный SLA spclient-эндпоинтов; реальный ответ обычно
 * приходит за <300 мс.
 */
const AUDIO_KEYS_TIMEOUT_MS = 5000;

/** Длина AES-128-ключа в байтах (R8.2). */
const AES_KEY_BYTE_LENGTH = 16;

/**
 * Запрашивает AES_Decryption_Key для пары (fileId, trackGid).
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 21.4, 21.6.
 *
 * Семантика ошибок:
 *   * 401 → invalidateSpotifyToken() + `SpotifyError("SPOTIFY_TOKEN_EXPIRED")` (R8.6).
 *   * 403 → `SpotifyError("SPOTIFY_DRM_PROTECTED", "Трек защищён DRM, скачивание невозможно")`
 *     БЕЗ вызова invalidateSpotifyToken (R8.3).
 *   * Прочее не-2xx → `SpotifyError("SPOTIFY_AUDIO_KEY_FAILED")` с HTTP-статусом
 *     в `reason` (R8.5).
 *   * Тело ответа длиной ≠ 16 байт → `SpotifyError("SPOTIFY_AUDIO_KEY_FAILED",
 *     "Получен ключ некорректного размера")` (R8.4).
 *   * Тайм-аут / abort → `SpotifyError("SPOTIFY_AUDIO_KEY_FAILED")`.
 *
 * @param fileId        — 40-символьный hex Spotify_File_Id (см. R6).
 * @param trackGid      — 32-символьный hex Track_GID (см. R9).
 * @param token         — Spotify_Access_Token (см. R4).
 * @param externalSignal— опциональный внешний AbortSignal от оркестратора;
 *                        при его срабатывании запрос отменяется немедленно.
 */
export async function fetchAudioKey(
  fileId: string,
  trackGid: string,
  token: string,
  externalSignal?: AbortSignal,
): Promise<Uint8Array> {
  // Точная форма URL зафиксирована в R8.1 и design § Pipeline шаг 7.
  // Завершающий "/0" — это feature-flag/format-id, который в текущем
  // Web-Player-протоколе всегда 0; см. протокол librespot.
  // Используем региональный spclient-хост (см. file-resolver).
  const host = getSpotifySpclientHost() ?? "spclient.wg.spotify.com";
  const url = `https://${host}/audio-keys/v1/key/${fileId}/${trackGid}/0`;

  // Per-request AbortController (R21.6): свой таймер на каждый вызов,
  // чтобы параллельные скачивания не делили общий timeout. Внешний
  // signal оркестратора форвардим через addEventListener — это работает
  // на всех таргетах (в отличие от AbortSignal.any, который доступен
  // не во всех Chromium-сборках, поддерживаемых расширением).
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUDIO_KEYS_TIMEOUT_MS);

  const onExternalAbort = (): void => controller.abort();
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    const clientToken = getSpotifyClientToken();
    if (clientToken !== null) {
      headers["client-token"] = clientToken;
    }
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    // R8.6: 401 → токен протух, инвалидируем кеш и репортим как
    // SPOTIFY_TOKEN_EXPIRED. Оркестратор в верхнем catch получит этот
    // код и вернёт content script соответствующий ответ.
    if (response.status === 401) {
      invalidateSpotifyToken();
      throw new SpotifyError(
        "SPOTIFY_TOKEN_EXPIRED",
        "audio-keys returned HTTP 401",
      );
    }

    // R8.3: 403 на этом эндпоинте — это именно DRM-защита, а не
    // протухший токен. Поэтому invalidateSpotifyToken НЕ вызываем —
    // токен ещё валиден для других треков той же сессии.
    if (response.status === 403) {
      throw new SpotifyError(
        "SPOTIFY_DRM_PROTECTED",
        "Трек защищён DRM, скачивание невозможно",
      );
    }

    // R8.5: любой другой не-2xx статус → SPOTIFY_AUDIO_KEY_FAILED.
    // HTTP-статус включаем в reason для диагностики, как требует R22.3.
    if (!response.ok) {
      throw new SpotifyError(
        "SPOTIFY_AUDIO_KEY_FAILED",
        `audio-keys returned HTTP ${response.status}`,
      );
    }

    // R8.2 / R8.4: тело должно быть ровно 16 байт. Любая другая длина —
    // некорректный ответ, который не имеет смысла продолжать дальше
    // в decryptSpotifyAudio (там бы всё равно упало с OperationError).
    const buf = await response.arrayBuffer();
    if (buf.byteLength !== AES_KEY_BYTE_LENGTH) {
      throw new SpotifyError(
        "SPOTIFY_AUDIO_KEY_FAILED",
        `Получен ключ некорректного размера: ${buf.byteLength} (ожидалось ${AES_KEY_BYTE_LENGTH})`,
      );
    }

    return new Uint8Array(buf);
  } catch (e) {
    // SpotifyError из веток выше пробрасываем как есть — у них уже
    // выставлены корректные code/reason.
    if (e instanceof SpotifyError) throw e;

    // AbortError из fetch может прийти и от нашего таймера, и от
    // externalSignal. В обоих случаях это «не удалось получить ключ» —
    // с точки зрения вызывающего кода различать незачем.
    if (e instanceof Error && e.name === "AbortError") {
      // Если внешний signal был отменён — оркестратор уже знает причину
      // и сам решит, что показывать пользователю; здесь мы просто
      // мапим на тот же errorCode, чтобы не вводить отдельный код.
      const reason =
        externalSignal !== undefined && externalSignal.aborted
          ? "Запрос audio-keys отменён"
          : "Превышено время ожидания audio-keys";
      throw new SpotifyError("SPOTIFY_AUDIO_KEY_FAILED", reason);
    }

    // Любая другая ошибка fetch (DNS, TLS, обрыв соединения) — это
    // тоже невозможность получить ключ. Включаем текст исходного
    // исключения в reason для диагностики.
    throw new SpotifyError(
      "SPOTIFY_AUDIO_KEY_FAILED",
      `Ошибка сети audio-keys: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // Чистим таймер и слушатель внешнего signal в любом случае —
    // и при успехе, и при ошибке. Иначе в долгоживущем SW будет
    // утечка таймеров и event-listener'ов.
    clearTimeout(timeoutId);
    if (externalSignal !== undefined) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}
