// Типы Spotify-пайплайна скачивания одиночных треков в MP3.
// Источник истины — design.md (секция «Data Models») и requirements.md
// (Requirement 22). Все типы используются и в background SW, и в
// content script, и в offscreen-документе через статические импорты.

// ─── Domain types ───────────────────────────────────────────────────────────

/**
 * Метаданные одного трека Spotify, извлечённые content script'ом из DOM
 * Web-плеера (либо переопределённые каноническими значениями из Web API
 * на стороне background SW).
 */
export interface SpotifyTrackMeta {
  /** 22-символьная base62-строка. */
  trackId: string;
  /** Формат "spotify:track:{trackId}". */
  trackUri: string;
  artist: string;
  title: string;
  albumTitle?: string;
  durationMs?: number;
}

/**
 * Метка формата аудиофайла из metadata-ответа Spotify.
 *
 * Поддерживаемые в этой итерации литералы перечислены явно; брендированный
 * fallback `(string & { readonly __brand?: "SpotifyFormat" })` оставляет
 * union открытым для прочих форматов из metadata-ответа, которые мы
 * НЕ поддерживаем и проводим в `selectBestFormat` как DRM.
 */
export type SpotifyFormat =
  | "OGG_VORBIS_96"
  | "OGG_VORBIS_160"
  | "OGG_VORBIS_320"
  | "MP4_128"
  | "MP4_256"
  // открытое расширение — для прочих форматов из metadata-ответа,
  // которые мы НЕ поддерживаем и проводим в `selectBestFormat` как drm.
  | (string & { readonly __brand?: "SpotifyFormat" });

/**
 * Запись `(format, fileId)` из плоского списка `audio_files` +
 * `alternatives[].audio_files` metadata-ответа.
 */
export interface SpotifyFormatEntry {
  format: SpotifyFormat;
  /** 40-символьная hex-строка (Spotify_File_Id). */
  fileId: string;
}

// ─── Wire messages ──────────────────────────────────────────────────────────

/**
 * Сообщение от content script к background SW: «начать скачивание трека».
 */
export interface SpotifyDownloadMessage {
  type: "SPOTIFY_DOWNLOAD_TRACK";
  payload: {
    /** Уникальный id, который content script подставляет, чтобы
     * различать несколько параллельных скачиваний (R14.4). */
    sessionId: string;
    trackMeta: SpotifyTrackMeta;
  };
}

/**
 * Прогресс-сообщение от background SW к content script во время CDN-fetch
 * (R7.5–7.6, R15.2). Отправляется не реже одного раза в 200 мс.
 */
export interface SpotifyDownloadProgressMessage {
  type: "SPOTIFY_DOWNLOAD_PROGRESS";
  payload: {
    sessionId: string;
    /** 0..100 либо null (R7.6 — нет Content-Length). */
    percent: number | null;
  };
}

/**
 * Замкнутое объединение всех кодов ошибок Spotify-пайплайна (R22).
 *
 * Ровно 11 литералов: добавление нового кода требует обновления словаря
 * пользовательских сообщений (`spotify-error-toast.ts`) и таблицы
 * маппинга в `spotify-download-handler.ts`.
 */
export type SpotifyErrorCode =
  | "SPOTIFY_TOKEN_UNAVAILABLE"
  | "SPOTIFY_TOKEN_EXPIRED"
  | "SPOTIFY_TRACK_ID_INVALID"
  | "SPOTIFY_METADATA_FAILED"
  | "SPOTIFY_DRM_PROTECTED"
  | "SPOTIFY_STORAGE_RESOLVE_FAILED"
  | "SPOTIFY_AUDIO_KEY_FAILED"
  | "SPOTIFY_CDN_FETCH_FAILED"
  | "SPOTIFY_DECRYPT_FAILED"
  | "SPOTIFY_TRANSCODE_FAILED"
  | "SPOTIFY_DOWNLOAD_FAILED";

/**
 * Discriminated-union ответа background SW на `SPOTIFY_DOWNLOAD_TRACK`.
 *
 * В success-ветке `actualFormat` всегда `"mp3"` (FLAC/WAV вне scope этой
 * итерации; при выборе пользователем flac/wav background применяет
 * fallback к MP3 и заполняет `fallbackReason`).
 *
 * В failure-ветке `reason` — всегда непустая строка (R22.3).
 */
export type SpotifyDownloadResponse =
  | {
      success: true;
      sessionId: string;
      downloadId: number;
      filename: string;
      /** Реальный формат результата ("mp3" в этой итерации). */
      actualFormat: "mp3";
      /** Если запрошен был flac/wav и применился fallback — пояснение. */
      fallbackReason?: string;
    }
  | {
      success: false;
      sessionId: string;
      errorCode: SpotifyErrorCode;
      reason: string;
    };

// ─── Internal pipeline shapes ───────────────────────────────────────────────

/**
 * Запись in-memory кеша Spotify_Access_Token в background SW (R4).
 *
 * Кеш хранится только в памяти SW; запись в `chrome.storage.*`
 * отсутствует и не предусмотрена.
 */
export interface SpotifyTokenCacheEntry {
  token: string;
  capturedAt: number;
}

/**
 * Результат запроса к эндпоинту `audio-keys` (R8): ровно 16 байт ключа
 * AES-128.
 */
export interface SpotifyAesKeyResult {
  bytes: Uint8Array; // 16 байт
}

/**
 * Зашифрованный Ogg-файл, скачанный с CDN (R7).
 *
 * `expectedLength` — `Content-Length` оригинального ответа CDN до снятия
 * Spotify-Vorbis-префикса; используется в `validateDecryption` (R18).
 */
export interface SpotifyEncryptedFile {
  bytes: Uint8Array;
  /** Content-Length оригинального ответа (или null, если не отдан). */
  expectedLength: number | null;
}
