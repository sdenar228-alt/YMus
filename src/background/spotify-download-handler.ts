// Оркестратор пайплайна скачивания одиночного трека Spotify в MP3.
// Реализует Requirements 5.1–5.6, 6.1–6.9, 7.1–7.9, 8.1–8.6, 10.1–10.8,
// 11.1–11.4, 12.1–12.8, 13.1–13.5, 14.5, 22.1, 22.3 и соответствует
// design.md § Pipeline (шаги 1..12), § F (parallelism), § L (error taxonomy).
//
// Контракт:
//   * Каждый вызов `handleSpotifyDownload` независим — у него свой
//     `AbortController`, свой `sessionId` и свой `chrome.downloads`-запрос.
//     Никакого глобального single-active-lock здесь нет (R14.5).
//   * Сетевые модули внутри пайплайна сами реализуют свои тайм-ауты
//     (R21.1–R21.5) и сами бросают `SpotifyError` с подходящими `errorCode`/
//     `reason`. Оркестратор просто перехватывает их и преобразует в
//     `SpotifyDownloadResponse`.
//   * На `signal.aborted` БЕЗ предшествующего `SpotifyError` оркестратор
//     мэппит ошибку на `errorCode` текущей стадии пайплайна и возвращает
//     `reason: "Превышено время ожидания"` (R21.6, R21.7).
//   * Шаги audio-key и (storage-resolve → CDN-fetch) запускаются параллельно
//     через `Promise.all`, чтобы порезать critical path (design § F).
//   * Прогресс CDN-fetch ретранслируется в content script через
//     `chrome.tabs.sendMessage(tabId, { type: "SPOTIFY_DOWNLOAD_PROGRESS",
//     payload: { sessionId, percent } })` не реже одного раза в 200 мс
//     (R7.5, R15.2 — тротлинг 200 мс живёт внутри `fetchEncryptedFile`).
//   * Транскодирование Ogg → MP3 выполняется в offscreen-документе через
//     сообщение `ENCODE_OGG_TO_MP3` с base64-конвертом (см. offscreen.ts).
//     Тайм-аут на ответ — 60 000 мс (R11.4); на тайм-аут — `SPOTIFY_TRANSCODE_FAILED`.
//   * Сохранение файла идёт через `downloadViaOffscreenBlob` (offscreen-bridge.ts):
//     offscreen минтит `blob:`-URL, SW зовёт `chrome.downloads.download`,
//     получает `downloadId`. Поверх — 5 000 мс ack-таймаут (R12.7); по нему —
//     `SPOTIFY_DOWNLOAD_FAILED`.

import type {
  SpotifyDownloadMessage,
  SpotifyDownloadResponse,
  SpotifyErrorCode,
} from "../shared/spotify-types";
import { getServiceFormatPreferences } from "../shared/format-storage";
import { SpotifyError } from "./spotify-errors";
import {
  getSpotifyAccessToken,
  waitForSpotifyClientToken,
} from "./spotify-token-capture";
import { trackIdToGid } from "./spotify-track-id";
import { fetchTrackFiles, selectBestFormat } from "./spotify-file-resolver";
import { resolveCdnUrl } from "./spotify-storage-resolve";
import { fetchEncryptedFile } from "./spotify-cdn-fetch";
import { fetchAudioKey } from "./spotify-audio-keys";
import {
  decryptSpotifyAudio,
  stripSpotifyVorbisPrefix,
  validateDecryption,
} from "./spotify-aes-decrypt";
import { sanitizeSpotifyFilename } from "./spotify-filename";
import {
  downloadViaOffscreenBlob,
  ensureOffscreenForYt as ensureOffscreenDocument,
} from "./offscreen-bridge";
import { bytesToBase64, base64ToBytes } from "../shared/base64";

// ─── Внутренние константы ──────────────────────────────────────────────────

/** Тайм-аут на ответ offscreen-документа на ENCODE_OGG_TO_MP3 (R11.4). */
const TRANSCODE_TIMEOUT_MS = 60_000;

/** Тайм-аут на ack от `chrome.downloads.download` (R12.7). */
const DOWNLOAD_ACK_TIMEOUT_MS = 5_000;

/**
 * Стадии пайплайна. Используются только для мэппинга `signal.aborted`
 * без предшествующего `SpotifyError` в подходящий `errorCode`.
 *
 * Порядок повторяет порядок шагов в `handleSpotifyDownload`; перевод
 * между стадиями делается явным присвоением `stage = "..."` перед
 * соответствующим `await`-вызовом.
 */
type Stage =
  | "token"
  | "metadata"
  | "track-files"
  | "storage-resolve-or-cdn"
  | "audio-key"
  | "decrypt"
  | "transcode"
  | "download";

/**
 * Карта `стадия → errorCode`. Используется только в catch-блоке оркестратора:
 * если `signal.aborted` сработал БЕЗ выброшенного `SpotifyError` (например,
 * аборт пришёл из-за гонки между параллельными ветками), мы возвращаем
 * пользователю код, наиболее точно описывающий стадию, на которой пайплайн
 * остановился.
 */
const STAGE_TO_ERROR_CODE: Readonly<Record<Stage, SpotifyErrorCode>> = {
  token: "SPOTIFY_TOKEN_UNAVAILABLE",
  metadata: "SPOTIFY_METADATA_FAILED",
  "track-files": "SPOTIFY_METADATA_FAILED",
  "storage-resolve-or-cdn": "SPOTIFY_CDN_FETCH_FAILED",
  "audio-key": "SPOTIFY_AUDIO_KEY_FAILED",
  decrypt: "SPOTIFY_DECRYPT_FAILED",
  transcode: "SPOTIFY_TRANSCODE_FAILED",
  download: "SPOTIFY_DOWNLOAD_FAILED",
};

// ─── Типы ответа offscreen-документа ───────────────────────────────────────

/**
 * Узкая форма ответа offscreen-документа на `ENCODE_OGG_TO_MP3`.
 *
 * Контракт зафиксирован в `src/offscreen/offscreen.ts`:
 *   * на успех — `{ ok: true, mp3DataB64 }`;
 *   * на ошибку — `{ ok: false, error }`.
 *
 * Передавать `Uint8Array` напрямую через `chrome.runtime.sendMessage` в MV3
 * ненадёжно (см. комментарий в offscreen.ts), поэтому байты ездят как
 * base64-строки в обоих направлениях.
 */
interface OffscreenEncodeResponse {
  ok: boolean;
  mp3DataB64?: string;
  error?: string;
}

// ─── Публичный API ─────────────────────────────────────────────────────────

/**
 * Полный pipeline скачивания одиночного трека Spotify.
 *
 * Ожидается, что вызывается из обработчика сообщений `chrome.runtime.onMessage`
 * (см. задачу 4.2 — подключение к message-router'у в `background.ts`).
 *
 * Возвращает discriminated-union `SpotifyDownloadResponse`:
 *   * `{ success: true, sessionId, downloadId, filename, actualFormat: "mp3", fallbackReason? }`
 *     при успехе. `fallbackReason` присутствует, если пользователь выбрал
 *     FLAC/WAV в popup'е — в этой итерации мы всё равно сохраняем MP3 и
 *     уведомляем UI о fallback'е (R13.3).
 *   * `{ success: false, sessionId, errorCode, reason }` при любой ошибке.
 *     `errorCode` — литерал из замкнутого объединения `SpotifyErrorCode`
 *     (R22.1); `reason` — гарантированно непустая строка (R22.3).
 *
 * Дополнительно во время CDN-fetch шлёт в content script сообщения
 * `SPOTIFY_DOWNLOAD_PROGRESS` через `chrome.tabs.sendMessage(sender.tab.id, ...)`.
 */
export async function handleSpotifyDownload(
  message: SpotifyDownloadMessage,
  sender: chrome.runtime.MessageSender,
): Promise<SpotifyDownloadResponse> {
  const { sessionId, trackMeta } = message.payload;

  // Свой `AbortController` на каждое скачивание (R14.5, design § F).
  // По нему останавливаются все висящие fetch'и пайплайна, когда любая
  // из стадий бросает ошибку.
  const controller = new AbortController();
  const signal = controller.signal;

  // Текущая стадия пайплайна. Обновляется перед каждым `await`-вызовом
  // соответствующего модуля. Используется только в catch-блоке для
  // мэппинга `signal.aborted` без `SpotifyError`.
  let stage: Stage = "token";
  const startedAt = performance.now();
  const stageStart = (s: Stage): void => {
    stage = s;
    console.info(
      `[ymd][spotify][${sessionId.slice(-8)}] → stage=${s} (t=${(performance.now() - startedAt).toFixed(0)}ms)`,
    );
  };
  console.info(
    `[ymd][spotify][${sessionId.slice(-8)}] start trackId=${trackMeta.trackId} title="${trackMeta.title}" artist="${trackMeta.artist}"`,
  );

  // ── Прогресс CDN-fetch → content script ─────────────────────────────────
  // tab.id может быть `undefined`, если сообщение пришло, например, из
  // popup'а или из теста; тогда просто не шлём прогресс — пайплайн
  // продолжается без UI-апдейтов.
  const tabId = sender.tab?.id;
  const sendProgress = (percent: number | null): void => {
    if (tabId === undefined) return;
    try {
      // `chrome.tabs.sendMessage` в MV3 возвращает Promise; на закрытой
      // вкладке либо при отсутствии listener'а отклоняется — глушим
      // ошибку, чтобы прогресс не ронял пайплайн.
      void chrome.tabs
        .sendMessage(tabId, {
          type: "SPOTIFY_DOWNLOAD_PROGRESS",
          payload: { sessionId, percent },
        })
        .catch(() => {
          /* tab закрыт / нет listener'а — игнорим */
        });
    } catch {
      /* sync-throw из chrome.* — не критично для пайплайна */
    }
  };

  try {
    // ─── R13: чтение формата из popup'а ────────────────────────────────────
    // FLAC/WAV в этой итерации не поддерживаются — продолжаем flow MP3 и
    // помечаем результат `fallbackReason`'ом (R13.2, R13.3, R13.4). Поле
    // `bulkFormat` игнорируем (плейлисты вне scope этой итерации, R13.5).
    let isFallback = false;
    try {
      const prefs = await getServiceFormatPreferences("spotify");
      isFallback =
        prefs.singleTrackFormat === "flac" ||
        prefs.singleTrackFormat === "wav";
    } catch {
      // chrome.storage недоступен (например, в тестовом окружении без
      // полифила) — fallback не применяем, идём как `mp3`.
    }

    // ─── 1) Spotify_Access_Token (R4) ──────────────────────────────────────
    stageStart("token");
    const token = await getSpotifyAccessToken(signal);

    // Параллельно ждём client-token до 1500 мс — без него многие
    // spclient.wg-эндпоинты (включая metadata/4/track) отвечают 404/401.
    // Не бросаем ошибку, если не появился: некоторые сценарии (regional
    // routing) могут работать и без него; решение примет HTTP-ответ.
    const clientToken = await waitForSpotifyClientToken(1500, signal);
    console.info(
      `[ymd][spotify][${sessionId.slice(-8)}]   clientToken=${clientToken === null ? "<missing>" : "✓ (suffix=…" + clientToken.slice(-6) + ")"}`,
    );

    // ─── 2) trackId → trackGid (R9) ────────────────────────────────────────
    // `trackIdToGid` сам бросит `SpotifyError("SPOTIFY_TRACK_ID_INVALID")`
    // при некорректном формате `trackId` (R3.7, R9.6) — без сетевых вызовов.
    const trackGid = trackIdToGid(trackMeta.trackId);
    console.info(
      `[ymd][spotify][${sessionId.slice(-8)}]   trackGid=${trackGid}`,
    );

    // ─── 3) metadata/4/track — список файлов + canonical meta (R5+R6) ─────
    // Один запрос вместо двух: метаданные (artist/title/album/duration) и
    // список доступных audio-файлов берём из того же ответа `spclient.wg`.
    // Публичный `api.spotify.com/v1/tracks` отдаёт 429 при использовании
    // токена Web-Player'а, поэтому мы туда не ходим.
    stageStart("track-files");
    const { files: formats, canonical: rawCanonical } = await fetchTrackFiles(
      trackMeta.trackId,
      token,
      signal,
    );

    // Если canonical пустой по какой-то причине — берём fallback из DOM-меты.
    const canonical = {
      artist:
        rawCanonical.artist.length > 0 ? rawCanonical.artist : trackMeta.artist,
      title:
        rawCanonical.title.length > 0 ? rawCanonical.title : trackMeta.title,
      albumTitle: rawCanonical.albumTitle ?? trackMeta.albumTitle,
      durationMs: rawCanonical.durationMs ?? trackMeta.durationMs,
    };
    console.info(
      `[ymd][spotify][${sessionId.slice(-8)}]   canonical: artist="${canonical.artist}" title="${canonical.title}"`,
    );
    console.info(
      `[ymd][spotify][${sessionId.slice(-8)}]   files=${formats.length} formats=[${formats.map((f) => f.format).join(",")}]`,
    );
    const selected = selectBestFormat(formats);
    if (selected.kind === "drm") {
      // Среди доступных файлов нет ни одного `OGG_VORBIS_*` (только MP4
      // и/или прочие) — мгновенно завершаем пайплайн с DRM-ошибкой (R6.7).
      throw new SpotifyError(
        "SPOTIFY_DRM_PROTECTED",
        "Трек защищён DRM, скачивание невозможно",
      );
    }
    console.info(
      `[ymd][spotify][${sessionId.slice(-8)}]   selected format=${selected.entry.format} fileId=${selected.entry.fileId}`,
    );
    const fileId = selected.entry.fileId;

    // ─── 5+6+7) Параллельно: audio-key и (storage-resolve → CDN-fetch) ────
    // design § F: режем critical path до
    //     max(audioKeyRTT, storageResolveRTT + cdnDownload)
    // вместо последовательной суммы. Внутри `fetchEncryptedFile` живёт
    // тротлинг прогресса 200 мс (R7.5, R15.2).
    stageStart("storage-resolve-or-cdn");
    const cdnTask = (async () => {
      const url = await resolveCdnUrl(fileId, token, signal);
      console.info(
        `[ymd][spotify][${sessionId.slice(-8)}]   cdnUrl=${url.slice(0, 80)}…`,
      );
      return fetchEncryptedFile(url, token, sendProgress, signal);
    })();
    const audioKeyTask = fetchAudioKey(fileId, trackGid, token, signal);

    let keyBytes: Uint8Array;
    let encrypted: { bytes: Uint8Array; expectedLength: number | null };
    try {
      [keyBytes, encrypted] = await Promise.all([audioKeyTask, cdnTask]);
    } catch (e) {
      // Уточняем стадию по типу `SpotifyError`, чтобы при `signal.aborted`
      // без `SpotifyError` (когда одна ветка отменила другую через
      // controller.abort) мэппинг указывал на наиболее вероятную стадию.
      if (e instanceof SpotifyError) {
        if (
          e.code === "SPOTIFY_AUDIO_KEY_FAILED" ||
          e.code === "SPOTIFY_DRM_PROTECTED"
        ) {
          stage = "audio-key";
        }
        // Прочие коды (SPOTIFY_CDN_FETCH_FAILED, SPOTIFY_STORAGE_RESOLVE_FAILED,
        // SPOTIFY_TOKEN_EXPIRED) корректно остаются в "storage-resolve-or-cdn".
      }
      throw e;
    }

    // ─── 8) AES-128-CTR расшифровка (R10) ─────────────────────────────────
    stageStart("decrypt");
    console.info(
      `[ymd][spotify][${sessionId.slice(-8)}]   encrypted=${encrypted.bytes.byteLength}B keyBytes=${keyBytes.byteLength}B contentLen=${encrypted.expectedLength ?? "<none>"}`,
    );
    const decrypted = await decryptSpotifyAudio(encrypted.bytes, keyBytes);

    // ─── 9) Снятие Spotify-Vorbis-префикса (R10.5) ────────────────────────
    const stripped = stripSpotifyVorbisPrefix(decrypted);
    console.info(
      `[ymd][spotify][${sessionId.slice(-8)}]   decrypted=${decrypted.byteLength}B stripped=${stripped.bytes.byteLength}B prefixLen=${stripped.prefixLen}`,
    );

    // ─── 10) validateDecryption (R18) ─────────────────────────────────────
    // Convention о длине (design § K): `expectedLength` — Content-Length
    // оригинального ответа CDN ДО снятия префикса. Если CDN не отдал
    // Content-Length, используем фактическую длину encrypted.bytes —
    // AES-CTR сохраняет длину побайтово (R18.5), поэтому это корректно.
    const expectedLength =
      encrypted.expectedLength ?? encrypted.bytes.byteLength;
    const validation = validateDecryption(
      stripped.bytes,
      expectedLength,
      stripped.prefixLen,
    );
    if (!validation.valid) {
      throw new SpotifyError("SPOTIFY_DECRYPT_FAILED", validation.reason);
    }

    // ─── 11) Транскод Ogg → MP3 в offscreen-документе (R11) ───────────────
    stageStart("transcode");
    const mp3Bytes = await transcodeOggToMp3(stripped.bytes, signal);
    console.info(
      `[ymd][spotify][${sessionId.slice(-8)}]   mp3=${mp3Bytes.byteLength}B`,
    );

    // ─── 12) Имя файла + chrome.downloads.download (R12) ──────────────────
    stageStart("download");
    const filename = sanitizeSpotifyFilename(
      canonical.artist,
      canonical.title,
      trackMeta.trackId,
    );
    const downloadId = await downloadMp3WithAckTimeout(mp3Bytes, filename);

    // R7.5: финальный 100% — `fetchEncryptedFile` уже отправляет 100% при
    // известном Content-Length, но если `Content-Length` был null,
    // последний переданный percent тоже null. Дублируем явный 100%, чтобы
    // UI закрыл прогрессбар и для индетерминированного случая.
    sendProgress(100);

    return {
      success: true,
      sessionId,
      downloadId,
      filename,
      actualFormat: "mp3",
      ...(isFallback
        ? {
            fallbackReason:
              "FLAC/WAV для Spotify пока не поддерживается, скачан MP3",
          }
        : {}),
    };
  } catch (e) {
    // Останавливаем все висящие fetch'и пайплайна (audio-key, CDN…),
    // чтобы они не доедали трафик после ошибки на параллельной ветке.
    controller.abort();

    if (e instanceof SpotifyError) {
      console.error(
        `[ymd][spotify][${sessionId.slice(-8)}] FAILED stage=${stage} code=${e.code} reason="${e.reason}"`,
      );
      return {
        success: false,
        sessionId,
        errorCode: e.code,
        reason: e.reason,
      };
    }
    if (signal.aborted) {
      const code = STAGE_TO_ERROR_CODE[stage];
      console.error(
        `[ymd][spotify][${sessionId.slice(-8)}] FAILED (aborted) stage=${stage} → ${code}`,
      );
      return {
        success: false,
        sessionId,
        errorCode: code,
        reason: "Превышено время ожидания",
      };
    }
    const code = STAGE_TO_ERROR_CODE[stage];
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[ymd][spotify][${sessionId.slice(-8)}] FAILED (unknown) stage=${stage} → ${code}: ${message}`,
      e,
    );
    return {
      success: false,
      sessionId,
      errorCode: code,
      reason: message,
    };
  }
}

// ─── Внутренние помощники ──────────────────────────────────────────────────

/**
 * Передаёт расшифрованный Ogg-Vorbis-буфер в offscreen-документ для
 * транскодирования в MP3 192 kbps. На каждый вызов — 60 000 мс зонтик
 * поверх `chrome.runtime.sendMessage` (R11.4).
 *
 * @throws {SpotifyError} `SPOTIFY_TRANSCODE_FAILED` на тайм-ауте, отказе
 *   offscreen-документа, или некорректном ответе.
 */
async function transcodeOggToMp3(
  oggBytes: Uint8Array,
  signal: AbortSignal,
): Promise<Uint8Array> {
  // Гарантируем, что offscreen-документ создан и его listener активен
  // (см. `ensureOffscreenForYt` — это generic helper, имя историческое).
  try {
    await ensureOffscreenDocument();
  } catch (e) {
    throw new SpotifyError(
      "SPOTIFY_TRANSCODE_FAILED",
      `Не удалось подготовить offscreen-документ: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // Кодируем байты в base64: см. комментарий в offscreen.ts о том, почему
  // плоский Uint8Array через chrome.runtime.sendMessage в MV3 ненадёжен.
  const bytesB64 = bytesToBase64(oggBytes);

  // Тайм-аут 60 000 мс через Promise.race (R11.4).
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new SpotifyError(
          "SPOTIFY_TRANSCODE_FAILED",
          "Ошибка транскодирования в MP3",
        ),
      );
    }, TRANSCODE_TIMEOUT_MS);
  });

  // Внешний signal (общий abort пайплайна) тоже должен прерывать ожидание,
  // чтобы пайплайн не висел при отмене на стадии транскода.
  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(
        new SpotifyError(
          "SPOTIFY_TRANSCODE_FAILED",
          "Транскодирование отменено",
        ),
      );
      return;
    }
    signal.addEventListener(
      "abort",
      () =>
        reject(
          new SpotifyError(
            "SPOTIFY_TRANSCODE_FAILED",
            "Транскодирование отменено",
          ),
        ),
      { once: true },
    );
  });

  try {
    const response = (await Promise.race([
      chrome.runtime.sendMessage({
        target: "offscreen",
        type: "ENCODE_OGG_TO_MP3",
        payload: {
          bytesB64,
          sourceMime: 'audio/ogg; codecs="vorbis"',
        },
      }),
      timeoutPromise,
      abortPromise,
    ])) as OffscreenEncodeResponse | undefined;

    if (!response) {
      throw new SpotifyError(
        "SPOTIFY_TRANSCODE_FAILED",
        "Offscreen не ответил на ENCODE_OGG_TO_MP3",
      );
    }
    if (!response.ok) {
      throw new SpotifyError(
        "SPOTIFY_TRANSCODE_FAILED",
        response.error && response.error.length > 0
          ? response.error
          : "Ошибка транскодирования в MP3",
      );
    }
    if (typeof response.mp3DataB64 !== "string") {
      throw new SpotifyError(
        "SPOTIFY_TRANSCODE_FAILED",
        "Offscreen вернул некорректный mp3DataB64",
      );
    }
    return base64ToBytes(response.mp3DataB64);
  } catch (e) {
    if (e instanceof SpotifyError) throw e;
    throw new SpotifyError(
      "SPOTIFY_TRANSCODE_FAILED",
      e instanceof Error ? e.message : String(e),
    );
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

/**
 * Сохраняет MP3-байты на диск через offscreen-blob bridge с тайм-аутом
 * 5 000 мс на ack от `chrome.downloads.download` (R12.7).
 *
 * @returns numeric `downloadId` от `chrome.downloads.download` (либо `-1`,
 *   если `downloadViaOffscreenBlob` ушёл по anchor-fallback'у на Yandex
 *   Browser/Vivaldi на macOS — это всё равно успех с точки зрения R12.7).
 *
 * @throws {SpotifyError} `SPOTIFY_DOWNLOAD_FAILED` на тайм-ауте либо при
 *   неуспешном результате `downloadViaOffscreenBlob`.
 */
async function downloadMp3WithAckTimeout(
  mp3Bytes: Uint8Array,
  filename: string,
): Promise<number> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new SpotifyError(
          "SPOTIFY_DOWNLOAD_FAILED",
          "Превышено время ожидания подтверждения загрузки",
        ),
      );
    }, DOWNLOAD_ACK_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      downloadViaOffscreenBlob(mp3Bytes, "audio/mpeg", filename),
      timeoutPromise,
    ]);
    if (!result.success) {
      throw new SpotifyError(
        "SPOTIFY_DOWNLOAD_FAILED",
        result.reason && result.reason.length > 0
          ? result.reason
          : "chrome.downloads.download не вернул downloadId",
      );
    }
    return result.downloadId;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
