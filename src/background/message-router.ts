// Message router for the Service Worker.
//
// Поддерживаемые типы:
//   AUTH_STATUS / AUTH_LOGOUT / OAUTH_LOGIN / OAUTH_TOKEN_RECEIVED
//   RESOLVE_TRACK    — получить URL + метаданные одного трека
//   RESOLVE_ALBUM    — получить список trackId для альбома
//   RESOLVE_PLAYLIST — получить список trackId для плейлиста
//   TRACK_CHANGED    — очистить кеш URL для предыдущего trackId

import { URLCache } from "./url-cache";
import {
  getDownloadInfoEntries,
  getSignedUrlFromEntry,
  getTrackInfo,
  findTrackByMetadata,
  getAlbumInfo,
  getPlaylistInfo,
  getCurrentUserLikedTracks,
  getPlaylistByUuid,
  DrmProtectedError,
  AuthRequiredError,
  PreviewOnlyError as ApiPreviewOnlyError,
} from "./api-client";
import { classifyError } from "./error-classifier";
import { logError } from "./logger";
import {
  getStoredToken,
  setStoredToken,
  clearStoredToken,
} from "../shared/auth";
import { sanitizeFolderName } from "../shared/folder-sanitizer";
import { authorizeAndSave } from "./oauth-flow";
import { buildId3v23Tag, fetchCover as fetchCoverBytes } from "./id3";
import { buildFilename } from "../shared/filename";
import { getFormatPreferences } from "../shared/format-storage";
import {
  resolveFormat,
  PreviewOnlyError as ResolverPreviewOnlyError,
} from "./format-resolver";
import { embedFlacMetadata } from "./flac-meta";
import { convertToWav, type SourceMime } from "./wav-converter";
import { buildWavFile } from "./wav-meta";
import { encodeMp3ToFlacInOffscreen, downloadViaOffscreenBlob } from "./offscreen-bridge";
import { bytesToBase64, base64ToBytes } from "../shared/base64";
import { convertVkAudio } from "./vk-format-converter";
import { buildYtFilename } from "../shared/yt-filename";
import type {
  AudioFormat,
  DownloadInfoEntry,
  FilenameParams,
  VkTrackMeta,
  VkErrorCode,
} from "../shared/types";
import { handleSpotifyDownload } from "./spotify-download-handler";
import type { SpotifyDownloadMessage } from "../shared/spotify-types";
import { VkApiClient, VkApiError } from "./vk-api-client";
import { VkUrlCache } from "./vk-url-cache";
import { createVkRateLimiter } from "./vk-rate-limiter";
import { buildVkFilename } from "../shared/vk-filename";
import { getServiceFormatPreferences } from "../shared/format-storage";

const API_TIMEOUT_MS = 30_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error("API timeout")), ms);
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

// MIME types per output format (Requirements 5.4, 5.5, 5.6).
const MIME_BY_FORMAT: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
};

// File extensions per output format (Requirements 5.1, 5.2, 5.3).
const EXT_BY_FORMAT: Record<AudioFormat, FilenameParams["codec"]> = {
  mp3: "mp3",
  flac: "flac",
  wav: "wav",
};

// ─── VK singleton instances ───────────────────────────────────────────────────

const vkUrlCache = new VkUrlCache();
const vkRateLimiter = createVkRateLimiter();
const vkApiClient = new VkApiClient(vkUrlCache, vkRateLimiter);

/**
 * Clamp a full download path to 240 characters, preserving the file extension.
 *
 * Handles `.mp3`, `.flac`, `.wav` — falls back to truncation without extension
 * preservation for unknown extensions.
 */
function clampDownloadPath(fullPath: string): string {
  const MAX_PATH = 240;
  if (fullPath.length <= MAX_PATH) return fullPath;

  // Detect the trailing extension (e.g. ".mp3", ".flac", ".wav").
  const dotIdx = fullPath.lastIndexOf(".");
  if (dotIdx === -1) return fullPath.slice(0, MAX_PATH);
  const ext = fullPath.slice(dotIdx); // includes the dot
  // Reasonable extension length guard — only preserve known short extensions.
  if (ext.length > 5) return fullPath.slice(0, MAX_PATH);

  return fullPath.slice(0, MAX_PATH - ext.length) + ext;
}

interface RouterResponse {
  success: boolean;
  url?: string;
  reason?: string;
  errorCode?: string;
  authorized?: boolean;
  trackInfo?: {
    trackId: string;
    artist: string;
    title: string;
    albumTitle: string | null;
    year: string | null;
    trackNumber: string | null;
    coverUri: string | null;
  };
  album?: { albumId: string; title: string; trackIds: string[] };
  playlist?: {
    owner: string;
    kind: string;
    title: string;
    trackIds: string[];
  };
  bytes?: number[];
  filename?: string;
  actualFormat?: AudioFormat;
  fallbackReason?: string;
  /**
   * Numeric id returned by `chrome.downloads.download()`. Set on every
   * successful DOWNLOAD_BY_INPUT and DOWNLOAD_TRACK response — the SW
   * performs the actual save itself, so consumers can rely on this field
   * to know that the file is now in chrome.downloads.
   */
  downloadId?: number;
  /** Base64-encoded audio data returned to content script for VK downloads */
  audioDataB64?: string;
  /** Download strategy used for VK tracks */
  strategy?: "direct" | "hls_demux";
  /** For VK playlist: progress info */
  progress?: { downloaded: number; total: number; skipped: number };
  /** Spotify session id (присутствует в ответах на SPOTIFY_DOWNLOAD_TRACK). */
  sessionId?: string;
}

type SendResponse = (response: RouterResponse) => void;

/**
 * Convert raw API DownloadInfo to the strict `DownloadInfoEntry` shape expected
 * by the resolver (`preview` becomes a required boolean).
 */
function normalizeEntries(
  raw: Array<{
    codec: string;
    bitrateInKbps: number;
    preview?: boolean;
    downloadInfoUrl: string;
    directUrl?: string;
  }>,
): DownloadInfoEntry[] {
  return raw.map((e) => ({
    codec: e.codec,
    bitrateInKbps: e.bitrateInKbps,
    preview: e.preview === true,
    downloadInfoUrl: e.downloadInfoUrl,
    directUrl: e.directUrl,
  }));
}

function parseTrackInputToId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  const m1 = trimmed.match(/\/track\/(\d+)/);
  if (m1 !== null) return m1[1];
  const m2 = trimmed.match(/^(\d+):/);
  if (m2 !== null) return m2[1];
  return null;
}

function normalizeMetaText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/ё/g, "е")
    .replace(/Ё/g, "е")
    .toLowerCase()
    .replace(/[\u200b-\u200f\uFEFF]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function metaTokens(text: string): string[] {
  return normalizeMetaText(text)
    .split(" ")
    .filter((token) => token.length > 0);
}

function trackInfoMatchesHint(
  info: { artist: string; title: string },
  hint?: { artist?: unknown; title?: unknown },
): boolean {
  const hintTitle =
    typeof hint?.title === "string" && hint.title.trim().length > 0
      ? hint.title
      : null;
  const hintArtist =
    typeof hint?.artist === "string" && hint.artist.trim().length > 0
      ? hint.artist
      : null;

  if (hintTitle === null && hintArtist === null) return true;
  if (hintTitle !== null && normalizeMetaText(info.title) !== normalizeMetaText(hintTitle)) {
    return false;
  }
  if (hintArtist === null) return true;

  const hintArtistTokens = metaTokens(hintArtist);
  const infoArtistTokens = metaTokens(info.artist);
  if (hintArtistTokens.length === 0) return true;
  return hintArtistTokens.some((token) => infoArtistTokens.includes(token));
}

interface ParsedAlbum {
  albumId: string;
}

function parseAlbumInput(input: string): ParsedAlbum | null {
  const t = input.trim();
  if (/^\d+$/.test(t)) return { albumId: t };
  const m = t.match(/\/album\/(\d+)(?!\/track)/);
  if (m !== null) return { albumId: m[1] };
  return null;
}

function parsePlaylistInput(
  input: string,
):
  | { kind: "classic"; owner: string; kindNumber: string }
  | { kind: "uuid"; uuid: string }
  | { kind: "likes" }
  | { kind: "chart" }
  | null {
  const t = input.trim();
  // /chart — Чарт Яндекс Музыки (плейлист uid=414787002, kind=1076)
  if (/\/chart(?:\/|$)/.test(t)) {
    return { kind: "chart" };
  }
  // /users/{owner}/playlists/{kind}
  const m1 = t.match(/\/users\/([^/]+)\/playlists\/([^/?#]+)/);
  if (m1 !== null) {
    return { kind: "classic", owner: m1[1], kindNumber: m1[2] };
  }
  // /playlists/lk.{uuid} — новый формат для "Мне нравится"
  const m2 = t.match(/\/playlists\/lk\.([0-9a-f-]+)/i);
  if (m2 !== null) return { kind: "uuid", uuid: `lk.${m2[1]}` };
  // /playlists/{uuid} — обычные кастомные плейлисты
  const m3 = t.match(/\/playlists\/([0-9a-f-]{8,})/i);
  if (m3 !== null) return { kind: "uuid", uuid: m3[1] };
  // /library/likes или просто /likes — это плейлист "Мне нравится"
  if (/\/library\/likes/.test(t) || /\/likes$/.test(t)) {
    return { kind: "likes" };
  }
  return null;
}

/**
 * Build the final tagged file bytes for the resolved output format.
 *
 * Returns the bytes to deliver, the actual MIME type, the actual format, and
 * an optional fallback reason (e.g. when WAV conversion failed and we're
 * delivering the source file instead).
 */
async function buildTaggedFile(args: {
  sourceBytes: Uint8Array;
  sourceCodec: string;
  outputFormat: AudioFormat;
  meta: {
    title: string;
    artist: string;
    album?: string;
    year?: string;
    trackNumber?: string;
    cover?: { bytes: Uint8Array; mime: "image/jpeg" | "image/png" };
  };
}): Promise<{
  bytes: Uint8Array;
  actualFormat: AudioFormat;
  fallbackReason?: string;
}> {
  const { sourceBytes, sourceCodec, outputFormat, meta } = args;

  if (outputFormat === "mp3") {
    const tag = buildId3v23Tag({
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      year: meta.year,
      trackNumber: meta.trackNumber,
      cover: meta.cover,
    });
    const out = new Uint8Array(tag.length + sourceBytes.length);
    out.set(tag, 0);
    out.set(sourceBytes, tag.length);
    return { bytes: out, actualFormat: "mp3" };
  }

  if (outputFormat === "flac") {
    // Если источник уже FLAC — просто вшиваем теги.
    if (sourceCodec === "flac") {
      const tagged = embedFlacMetadata(sourceBytes, {
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        year: meta.year,
        trackNumber: meta.trackNumber,
        cover: meta.cover,
      });
      return { bytes: tagged, actualFormat: "flac" };
    }

    // Иначе — перепаковываем lossy → FLAC через offscreen+libflac.
    // Это не делает звук lossless (исходник остаётся MP3 320), но
    // пользователь получает .flac контейнер.
    const sourceMime: SourceMime =
      sourceCodec === "flac" ? "audio/flac" : "audio/mpeg";
    const enc = await encodeMp3ToFlacInOffscreen(sourceBytes, sourceMime);

    if (enc.success) {
      // У свежего FLAC от libflac уже есть STREAMINFO + минимальный набор блоков.
      // Вшиваем поверх Vorbis Comment + PICTURE.
      const tagged = embedFlacMetadata(enc.flacBytes, {
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        year: meta.year,
        trackNumber: meta.trackNumber,
        cover: meta.cover,
      });
      return {
        bytes: tagged,
        actualFormat: "flac",
        fallbackReason:
          "FLAC получен перекодированием MP3 (исходник не lossless)",
      };
    }

    // Перекодирование упало — отдаём source как MP3.
    console.warn("[ymd][flac-encode] перепаковка упала:", enc.reason);
    const tag = buildId3v23Tag({
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      year: meta.year,
      trackNumber: meta.trackNumber,
      cover: meta.cover,
    });
    const out = new Uint8Array(tag.length + sourceBytes.length);
    out.set(tag, 0);
    out.set(sourceBytes, tag.length);
    return {
      bytes: out,
      actualFormat: "mp3",
      fallbackReason: `Не удалось получить FLAC: ${enc.reason}`,
    };
  }

  // outputFormat === "wav" — нужно конвертировать source.
  const sourceMime: SourceMime =
    sourceCodec === "flac" ? "audio/flac" : "audio/mpeg";
  const tWav0 = performance.now();
  const conv = await convertToWav(sourceBytes, sourceMime);
  const tWav1 = performance.now();
  console.info(
    `[ymd][wav] convertToWav (decode+pcm+transfer) → ${(tWav1 - tWav0).toFixed(0)}ms`,
  );

  if (conv.success) {
    const wav = buildWavFile(
      conv.pcmData,
      conv.sampleRate,
      conv.channels,
      conv.bitsPerSample,
      {
        artist: meta.artist,
        title: meta.title,
        album: meta.album,
        year: meta.year,
        trackNumber: meta.trackNumber,
      },
    );
    const tWav2 = performance.now();
    console.info(
      `[ymd][wav] buildWavFile → ${(tWav2 - tWav1).toFixed(0)}ms (${wav.length} bytes)`,
    );
    return { bytes: wav, actualFormat: "wav" };
  }

  // Конверсия не удалась — отдаём исходный файл (source) с правильным форматом.
  // Тегирование source: FLAC → embedFlacMetadata, MP3 → buildId3v23Tag.
  const fallbackFormat: AudioFormat = sourceCodec === "flac" ? "flac" : "mp3";
  if (fallbackFormat === "flac") {
    const tagged = embedFlacMetadata(sourceBytes, {
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      year: meta.year,
      trackNumber: meta.trackNumber,
      cover: meta.cover,
    });
    return {
      bytes: tagged,
      actualFormat: "flac",
      fallbackReason: `Конвертация в WAV не удалась, скачан в FLAC: ${conv.reason}`,
    };
  }

  const tag = buildId3v23Tag({
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    year: meta.year,
    trackNumber: meta.trackNumber,
    cover: meta.cover,
  });
  const out = new Uint8Array(tag.length + sourceBytes.length);
  out.set(tag, 0);
  out.set(sourceBytes, tag.length);
  return {
    bytes: out,
    actualFormat: "mp3",
    fallbackReason: `Конвертация в WAV не удалась, скачан в MP3: ${conv.reason}`,
  };
}

/**
 * [DEBUG] Определяет реальный формат файла по первым байтам.
 * Помогает диагностировать ситуацию, когда хост отдаёт MP3 вместо FLAC.
 */
function detectMagicFormat(bytes: Uint8Array): string {
  if (bytes.length < 4) return "too-short";
  // FLAC: "fLaC"
  if (
    bytes[0] === 0x66 &&
    bytes[1] === 0x4c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x43
  ) {
    return "flac";
  }
  // ID3v2 (MP3 with metadata): "ID3"
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "mp3 (ID3v2)";
  }
  // MP3 frame sync: 0xFF 0xFB/0xFA/0xF3/0xF2
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "mp3 (frame sync)";
  }
  // RIFF (WAV): "RIFF"
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return "riff/wav";
  }
  // AAC ADTS: 0xFF 0xF1 / 0xF9
  if (bytes[0] === 0xff && (bytes[1] === 0xf1 || bytes[1] === 0xf9)) {
    return "aac (adts)";
  }
  // OGG: "OggS"
  if (
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return "ogg";
  }
  return `unknown (${Array.from(bytes.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")})`;
}

/**
 * Fetch audio URL via VK's reload_audio endpoint directly.
 * Bypass session validation / rate limiter — user already has VK cookies.
 */
async function fetchReloadAudioUrl(ownerId: string, audioId: string): Promise<string | null> {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "vk.com" });
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const body = new URLSearchParams({
      act: "reload_audio",
      ids: `${ownerId}_${audioId}`,
      al: "1",
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    const resp = await fetch("https://vk.com/al_audio.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": cookieHeader,
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!resp.ok) {
      console.log(`[ymd] reload_audio HTTP ${resp.status}`);
      return null;
    }

    const text = await resp.text();
    // Response contains audio array: [audioId, ownerId, "url", ...]
    const urlMatch = text.match(/"(https:\/\/[^"]*?\.(?:m3u8|mp3)[^"]*)"/);
    if (urlMatch) {
      console.log(`[ymd] reload_audio got URL: ${urlMatch[1].substring(0, 60)}...`);
      return urlMatch[1];
    }

    console.log(`[ymd] reload_audio: no URL found in response (${text.length} chars)`);
    return null;
  } catch (e: any) {
    console.log(`[ymd] reload_audio error: ${e?.message || e}`);
    return null;
  }
}

export function createMessageRouter(
  cache: URLCache,
): (
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: SendResponse,
) => boolean {
  return (message, _sender, sendResponse) => {
    // Offscreen messages: SW не должен пытаться их обрабатывать. Возвращаем
    // false синхронно, чтобы Chrome не зарезервировал sendResponse за SW и
    // отдал его реальному обработчику в offscreen-документе.
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { target?: unknown }).target === "offscreen"
    ) {
      return false;
    }

    void (async () => {
      try {
        if (
          typeof message !== "object" ||
          message === null ||
          !("type" in message)
        ) {
          sendResponse({ success: false, reason: "Invalid message" });
          return;
        }

        const type = (message as { type: unknown }).type;

        switch (type) {
          case "OAUTH_LOGIN": {
            await authorizeAndSave();
            sendResponse({ success: true });
            return;
          }

          case "OAUTH_TOKEN_RECEIVED": {
            const token = (message as { payload?: { token?: unknown } })
              .payload?.token;
            if (typeof token !== "string" || token.length === 0) {
              sendResponse({ success: false, reason: "No token in payload" });
              return;
            }
            await setStoredToken(token);
            sendResponse({ success: true });
            return;
          }

          case "AUTH_STATUS": {
            const token = await getStoredToken();
            sendResponse({ success: true, authorized: token !== null });
            return;
          }

          case "AUTH_LOGOUT": {
            await clearStoredToken();
            sendResponse({ success: true });
            return;
          }

          case "DOWNLOAD_TRACK": {
            // Скачивание целиком в SW (обходит CORS). Save is performed by
            // the SW via chrome.downloads.download for both bulk (folder
            // present) and single-track (no folder) flows — the response
            // includes a numeric `downloadId` only after the download API
            // resolved. This unifies the success contract across all formats.
            const payload = (
              message as {
                payload?: {
                  trackId?: unknown;
                  meta?: { artist?: unknown; title?: unknown };
                  folder?: unknown;
                  requestId?: unknown;
                };
              }
            ).payload;
            const trackIdRaw = payload?.trackId;
            if (typeof trackIdRaw !== "string") {
              sendResponse({ success: false, reason: "No trackId" });
              return;
            }
            let trackId = parseTrackInputToId(trackIdRaw) ?? trackIdRaw;

            // requestId + senderTabId enable live progress callbacks back to
            // the originating content script. Optional — old callers that
            // don't pass requestId just skip progress reporting silently.
            const requestId =
              typeof payload?.requestId === "string" ? payload.requestId : null;
            const senderTabId = _sender?.tab?.id;
            const sendProgress = (loaded: number, total: number): void => {
              if (requestId === null || senderTabId === undefined) return;
              const pct =
                total > 0
                  ? Math.max(0, Math.min(99, Math.round((loaded / total) * 99)))
                  : -1;
              try {
                chrome.tabs
                  .sendMessage(senderTabId, {
                    type: "YM_TRACK_PROGRESS",
                    requestId,
                    trackId,
                    loaded,
                    total,
                    percent: pct,
                  })
                  .catch(() => {
                    /* tab closed, ignore */
                  });
              } catch {
                /* ignore */
              }
            };

            // Determine preferred format: bulk (folder present) vs single track.
            const folder = payload?.folder;
            const isBulk =
              typeof folder === "string" && folder.trim().length > 0;
            const prefs = await getFormatPreferences();
            const preferredFormat = isBulk
              ? prefs.bulkFormat
              : prefs.singleTrackFormat;

            let info = await getTrackInfo(trackId);
            const hint = payload?.meta;
            if (!trackInfoMatchesHint(info, hint)) {
              console.warn("[ymd][download-track][mismatch]", {
                requestedTrackId: trackId,
                requestedInfo: {
                  artist: info.artist,
                  title: info.title,
                },
                hint,
              });

              const hintArtist =
                typeof hint?.artist === "string" ? hint.artist.trim() : "";
              const hintTitle =
                typeof hint?.title === "string" ? hint.title.trim() : "";
              const corrected =
                hintArtist.length > 0 || hintTitle.length > 0
                  ? await findTrackByMetadata(hintArtist, hintTitle).catch((e) => {
                      console.warn("[ymd][download-track][search-correct] failed:", e);
                      return null;
                    })
                  : null;

              if (corrected !== null && trackInfoMatchesHint(corrected, hint)) {
                console.info("[ymd][download-track][corrected-track-id]", {
                  from: trackId,
                  to: corrected.trackId,
                  artist: corrected.artist,
                  title: corrected.title,
                });
                trackId = corrected.trackId;
                info = corrected;
              } else {
                sendResponse({
                  success: false,
                  errorCode: "INVALID_REQUEST",
                  reason:
                    "Яндекс Музыка отдала ID другого трека. Расширение остановило скачивание, чтобы не сохранить следующий трек под текущим названием.",
                });
                return;
              }
            }

            // Resolve format: get all download-info entries, pick the right one.
            const rawEntries = await getDownloadInfoEntries(trackId);
            const entries = normalizeEntries(rawEntries);
            const resolved = resolveFormat(entries, preferredFormat);

            // [DEBUG] Что выбрал резолвер.
            console.info(
              "[ymd][resolve][DOWNLOAD_TRACK] preferred=",
              preferredFormat,
              "→ outputFormat=",
              resolved.outputFormat,
              "entry={ codec:",
              resolved.entry.codec,
              ", bitrate:",
              resolved.entry.bitrateInKbps,
              "} fellBack=",
              resolved.fellBack,
              "reason=",
              resolved.fallbackReason ?? "—",
            );

            const signedUrl = await getSignedUrlFromEntry(
              resolved.entry.downloadInfoUrl,
              resolved.entry.codec,
              resolved.entry.directUrl,
            );

            const artist =
              typeof hint?.artist === "string" && hint.artist.length > 0
                ? hint.artist
                : info.artist;
            const title =
              typeof hint?.title === "string" && hint.title.length > 0
                ? hint.title
                : info.title;

            // Fetch source bytes + cover art in parallel (CORS bypassed via host_permissions).
            // The signed-URL fetch is streamed via fetchWithProgress so we
            // can report real byte-level progress back to the UI ring.
            const { fetchWithProgress } = await import("./fetch-progress");
            const [sourceResult, coverBytes] = await Promise.all([
              fetchWithProgress(signedUrl, sendProgress).catch((err) => {
                throw err instanceof Error
                  ? err
                  : new Error(String(err));
              }),
              info.coverUri !== null
                ? fetchCoverBytes(info.coverUri)
                : Promise.resolve(null),
            ]);
            const sourceBytes = sourceResult.bytes;

            // [DEBUG] Что реально пришло с хоста для DOWNLOAD_TRACK.
            console.info(
              "[ymd][source][DOWNLOAD_TRACK] bytes=",
              sourceBytes.length,
              "magic=",
              detectMagicFormat(sourceBytes),
              "expectedCodec=",
              resolved.entry.codec,
            );

            // Build tagged file in the actual output format (with WAV fallback).
            const built = await buildTaggedFile({
              sourceBytes,
              sourceCodec: resolved.entry.codec,
              outputFormat: resolved.outputFormat,
              meta: {
                title,
                artist,
                album: info.albumTitle ?? undefined,
                year: info.year ?? undefined,
                trackNumber: info.trackNumber ?? undefined,
                cover: coverBytes ?? undefined,
              },
            });

            // Combined fallback reason: from resolver (FLAC→MP3) and/or WAV failure.
            const fallbackReason =
              built.fallbackReason ?? resolved.fallbackReason;

            const filename = buildFilename({
              artist,
              title,
              codec: EXT_BY_FORMAT[built.actualFormat],
              trackId,
            });

            // If folder is provided — save via chrome.downloads.download.
            // Route through the offscreen blob bridge so Yandex Browser on
            // macOS doesn't replace the filename with "загруженное.<ext>".
            if (isBulk) {
              const sanitizedFolder = sanitizeFolderName(folder as string);
              const fullPath = `${sanitizedFolder}/${filename}`;
              const clampedPath = clampDownloadPath(fullPath);

              const tDl0 = performance.now();
              const mime = MIME_BY_FORMAT[built.actualFormat];
              try {
                const r = await downloadViaOffscreenBlob(
                  built.bytes,
                  mime,
                  clampedPath,
                );
                console.info(
                  `[ymd][dl-track] offscreen blob download → ${(performance.now() - tDl0).toFixed(0)}ms (${built.bytes.length} bytes)`,
                );

                if (!r.success) {
                  sendResponse({ success: false, reason: r.reason });
                  return;
                }
                if (chrome.runtime.lastError) {
                  const reason =
                    chrome.runtime.lastError.message ?? "Download failed";
                  sendResponse({ success: false, reason });
                  return;
                }
                sendResponse({
                  success: true,
                  filename: clampedPath,
                  actualFormat: built.actualFormat,
                  fallbackReason,
                  downloadId: r.downloadId,
                });
              } catch (dlError) {
                const reason =
                  dlError instanceof Error
                    ? dlError.message
                    : "Download failed";
                sendResponse({ success: false, reason });
              }
              return;
            }

            // No folder — single-track flow (popup direct or floating-button).
            // Perform the actual chrome.downloads.download() in the SW so the
            // success response is gated on a real downloadId. This unifies the
            // contract across MP3/FLAC/WAV: success ⇔ chrome.downloads.download
            // returned a numeric id.
            //
            // We route through the offscreen document so the file gets a real
            // blob: URL — Yandex Browser on macOS ignores `filename` for
            // `data:` URLs and saves files as "загруженное.<ext>" instead.
            {
              const tDl0 = performance.now();
              const mime = MIME_BY_FORMAT[built.actualFormat];
              try {
                const r = await downloadViaOffscreenBlob(
                  built.bytes,
                  mime,
                  filename,
                );
                console.info(
                  `[ymd][dl-track][no-folder] offscreen blob download → ${(
                    performance.now() - tDl0
                  ).toFixed(0)}ms (${built.bytes.length} bytes)`,
                );

                if (!r.success) {
                  sendResponse({ success: false, reason: r.reason });
                  return;
                }

                if (chrome.runtime.lastError) {
                  const reason =
                    chrome.runtime.lastError.message ?? "Download failed";
                  sendResponse({ success: false, reason });
                  return;
                }

                sendResponse({
                  success: true,
                  filename,
                  actualFormat: built.actualFormat,
                  fallbackReason,
                  downloadId: r.downloadId,
                });
              } catch (dlError) {
                const reason =
                  dlError instanceof Error
                    ? dlError.message
                    : "Download failed";
                sendResponse({ success: false, reason });
              }
              return;
            }
          }

          case "DOWNLOAD_BY_INPUT": {
            // Скачивание из popup: пользователь ввёл URL/ID трека, мы парсим,
            // прогоняем через тот же pipeline, что и DOWNLOAD_TRACK без folder,
            // но сохраняем файл сами через chrome.downloads.download (popup
            // не имеет доступа к bytes-флоу content script'а).
            //
            // Возвращаем actualFormat и fallbackReason, чтобы popup мог показать
            // уведомление о фолбэке (Requirements 6.1, 6.3, 6.4).
            const payload = (
              message as { payload?: { input?: unknown } }
            ).payload;
            const inputRaw = payload?.input;
            if (typeof inputRaw !== "string") {
              sendResponse({ success: false, reason: "No input" });
              return;
            }
            const trackId = parseTrackInputToId(inputRaw);
            if (trackId === null) {
              sendResponse({
                success: false,
                reason:
                  "Не удалось распознать ID трека. Поддерживаются URL вида " +
                  "/track/{id} или просто число.",
              });
              return;
            }

            // Single-track preference (popup всегда single-track).
            const prefs = await getFormatPreferences();
            const preferredFormat = prefs.singleTrackFormat;

            const rawEntries = await getDownloadInfoEntries(trackId);
            const entries = normalizeEntries(rawEntries);
            const resolved = resolveFormat(entries, preferredFormat);

            // [DEBUG] Что выбрал резолвер для попап-флоу.
            console.info(
              "[ymd][resolve][DOWNLOAD_BY_INPUT] preferred=",
              preferredFormat,
              "→ outputFormat=",
              resolved.outputFormat,
              "entry={ codec:",
              resolved.entry.codec,
              ", bitrate:",
              resolved.entry.bitrateInKbps,
              "} fellBack=",
              resolved.fellBack,
              "reason=",
              resolved.fallbackReason ?? "—",
            );

            const signedUrl = await getSignedUrlFromEntry(
              resolved.entry.downloadInfoUrl,
              resolved.entry.codec,
              resolved.entry.directUrl,
            );

            const info = await getTrackInfo(trackId);

            const [sourceResp, coverBytes] = await Promise.all([
              fetch(signedUrl),
              info.coverUri !== null
                ? fetchCoverBytes(info.coverUri)
                : Promise.resolve(null),
            ]);
            if (!sourceResp.ok) {
              sendResponse({
                success: false,
                reason: `Не удалось скачать исходный файл: HTTP ${sourceResp.status}`,
              });
              return;
            }
            const sourceBuf = await sourceResp.arrayBuffer();
            const sourceBytes = new Uint8Array(sourceBuf);

            // [DEBUG] Что реально пришло с хоста для DOWNLOAD_BY_INPUT.
            console.info(
              "[ymd][source][DOWNLOAD_BY_INPUT] bytes=",
              sourceBytes.length,
              "magic=",
              detectMagicFormat(sourceBytes),
              "expectedCodec=",
              resolved.entry.codec,
            );

            const built = await buildTaggedFile({
              sourceBytes,
              sourceCodec: resolved.entry.codec,
              outputFormat: resolved.outputFormat,
              meta: {
                title: info.title,
                artist: info.artist,
                album: info.albumTitle ?? undefined,
                year: info.year ?? undefined,
                trackNumber: info.trackNumber ?? undefined,
                cover: coverBytes ?? undefined,
              },
            });

            const fallbackReason =
              built.fallbackReason ?? resolved.fallbackReason;

            const filename = buildFilename({
              artist: info.artist,
              title: info.title,
              codec: EXT_BY_FORMAT[built.actualFormat],
              trackId,
            });
            const clampedPath = clampDownloadPath(filename);

            // Route through offscreen blob bridge so Yandex Browser preserves
            // the filename instead of saving as "загруженное.<ext>".
            const tDl0 = performance.now();
            const mime = MIME_BY_FORMAT[built.actualFormat];

            try {
              const r = await downloadViaOffscreenBlob(built.bytes, mime, clampedPath);
              console.info(
                `[ymd][dl-by-input] offscreen blob download → ${(performance.now() - tDl0).toFixed(0)}ms (${built.bytes.length} bytes)`,
              );

              if (!r.success) {
                sendResponse({ success: false, reason: r.reason });
                return;
              }
              if (chrome.runtime.lastError) {
                const reason =
                  chrome.runtime.lastError.message ?? "Download failed";
                sendResponse({ success: false, reason });
                return;
              }

              sendResponse({
                success: true,
                filename: clampedPath,
                actualFormat: built.actualFormat,
                fallbackReason,
                downloadId: r.downloadId,
              });
            } catch (dlError) {
              const reason =
                dlError instanceof Error ? dlError.message : "Download failed";
              sendResponse({ success: false, reason });
            }
            return;
          }

          case "RESOLVE_ALBUM": {
            const input = (
              message as { payload?: { input?: unknown } }
            ).payload?.input;
            if (typeof input !== "string") {
              sendResponse({ success: false, reason: "No input" });
              return;
            }
            const parsed = parseAlbumInput(input);
            if (parsed === null) {
              sendResponse({
                success: false,
                reason:
                  "Не удалось распознать ID альбома (нужен URL вида /album/{id})",
              });
              return;
            }
            const album = await getAlbumInfo(parsed.albumId);
            sendResponse({ success: true, album });
            return;
          }

          case "RESOLVE_PLAYLIST": {
            const input = (
              message as { payload?: { input?: unknown } }
            ).payload?.input;
            if (typeof input !== "string") {
              sendResponse({ success: false, reason: "No input" });
              return;
            }
            const parsed = parsePlaylistInput(input);
            if (parsed === null) {
              sendResponse({
                success: false,
                reason:
                  "Не удалось распознать плейлист. Поддерживаются URL " +
                  "/users/{login}/playlists/{N}, /playlists/lk.{uuid}, /library/likes.",
              });
              return;
            }
            let playlist;
            if (parsed.kind === "likes") {
              playlist = await getCurrentUserLikedTracks();
            } else if (parsed.kind === "uuid") {
              playlist = await getPlaylistByUuid(parsed.uuid);
            } else if (parsed.kind === "chart") {
              // Чарт Яндекс Музыки — пробуем несколько способов
              // 1. Как обычный плейлист (uid/kind из SSR)
              let chartPlaylist = await getPlaylistInfo("414787002", "1076").catch(() => null);
              if (chartPlaylist === null) {
                // 2. Через UUID
                chartPlaylist = await getPlaylistByUuid("ch.448df3eb-daee-408a-a60a-252259db2f3b").catch(() => null);
              }
              if (chartPlaylist === null) {
                sendResponse({
                  success: false,
                  reason: "Не удалось получить чарт через API",
                });
                return;
              }
              playlist = chartPlaylist;
            } else {
              playlist = await getPlaylistInfo(parsed.owner, parsed.kindNumber);
            }
            sendResponse({ success: true, playlist });
            return;
          }

          case "FETCH_HISTORY": {
            // Fetches the full music history from Yandex Music API.
            // We execute fetch in the MAIN world of the music.yandex.ru tab
            // so that session cookies are automatically attached (same-origin).
            try {
              // Find the music.yandex.ru tab
              const tabs = await chrome.tabs.query({
                url: "https://music.yandex.ru/*",
              });
              const tab = tabs.find((t) => t.id !== undefined);
              if (!tab || tab.id === undefined) {
                sendResponse({
                  success: false,
                  reason: "No music.yandex.ru tab found",
                });
                return;
              }

              const results = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: "MAIN",
                func: async () => {
                  try {
                    const resp = await fetch(
                      "https://api.music.yandex.ru/music-history/items",
                      {
                        method: "POST",
                        credentials: "include",
                        headers: {
                          "Content-Type": "application/json",
                          "X-Yandex-Music-Client":
                            "YandexMusicWebNext/1.0.0",
                          "X-Requested-With": "XMLHttpRequest",
                          "X-Retpath-Y":
                            "https://music.yandex.ru/music-history",
                        },
                        body: "{}",
                      },
                    );
                    if (!resp.ok) {
                      return { success: false, reason: `HTTP ${resp.status}` };
                    }
                    const data = await resp.json();
                    const items = data.items || [];
                    const trackIds = [];
                    for (const item of items) {
                      const d = item.data;
                      const trackId =
                        d?.itemId?.trackId ||
                        (d?.fullModel?.realId != null
                          ? String(d.fullModel.realId)
                          : d?.fullModel?.id != null
                            ? String(d.fullModel.id)
                            : null);
                      if (trackId) trackIds.push(trackId);
                    }
                    return { success: true, trackIds };
                  } catch (e) {
                    return {
                      success: false,
                      reason: e instanceof Error ? e.message : "fetch failed",
                    };
                  }
                },
              });

              const result = results?.[0]?.result as
                | { success: boolean; trackIds?: string[]; reason?: string }
                | undefined;
              if (!result || !result.success) {
                sendResponse({
                  success: false,
                  reason: result?.reason ?? "executeScript failed",
                });
                return;
              }
              sendResponse({ success: true, trackIds: result.trackIds } as any);
            } catch (e) {
              sendResponse({
                success: false,
                reason: e instanceof Error ? e.message : "Fetch history failed",
              });
            }
            return;
          }

          case "TRACK_CHANGED": {
            const previousTrackId = (
              message as { payload?: { previousTrackId?: unknown } }
            ).payload?.previousTrackId;
            if (typeof previousTrackId === "string") {
              cache.delete(previousTrackId);
            }
            sendResponse({ success: true });
            return;
          }

          case "VK_DOWNLOAD_DIRECT": {
            // Direct URL download — handles both direct mp3 URLs and HLS m3u8 streams
            const p = (message as any).payload;
            if (!p?.url || !p?.filename) {
              sendResponse({ success: false, error: "Missing url or filename" });
              return;
            }
            try {
              const url: string = p.url;
              const filename: string = p.filename;

              if (url.includes(".m3u8") || url.includes("/index.m3u8")) {
                // HLS stream — download segments via vk-hls-downloader, save as blob
                const { downloadVkHlsTrack } = await import("./vk-hls-downloader");
                const audioBuffer = await downloadVkHlsTrack(url);
                
                // Convert ArrayBuffer to base64 data URL for chrome.downloads
                const base64 = bytesToBase64(new Uint8Array(audioBuffer));
                const dataUrl = `data:audio/mpeg;base64,${base64}`;
                
                const downloadId = await chrome.downloads.download({
                  url: dataUrl,
                  filename,
                  conflictAction: "uniquify",
                });
                sendResponse({ success: true, downloadId });
              } else {
                // Direct mp3 URL — simple download
                const downloadId = await chrome.downloads.download({
                  url,
                  filename,
                  conflictAction: "uniquify",
                });
                sendResponse({ success: true, downloadId });
              }
            } catch (err: any) {
              sendResponse({ success: false, error: err?.message || "Download failed" });
            }
            return;
          }

          case "VK_DOWNLOAD_TRACK": {
            const payload = (message as { payload?: VkTrackMeta & { requestId?: string } }).payload;
            if (
              !payload ||
              typeof payload.ownerId !== "string" ||
              typeof payload.audioId !== "string"
            ) {
              sendResponse({ success: false, reason: "Invalid VK track payload" });
              return;
            }

            const { ownerId, audioId, artist, title } = payload;
            const requestId = payload.requestId;
            const senderTabId = _sender?.tab?.id;

            // Helper to push live progress (0..100) back to the originating
            // tab. content-script keys updates by requestId so multiple
            // concurrent downloads in the same tab don't get mixed up.
            const sendProgress = (pct: number): void => {
              if (!requestId || senderTabId === undefined) return;
              try {
                chrome.tabs.sendMessage(senderTabId, {
                  type: "VK_TRACK_PROGRESS",
                  requestId,
                  ownerId,
                  audioId,
                  percent: Math.max(0, Math.min(100, Math.round(pct))),
                }).catch(() => { /* tab closed, ignore */ });
              } catch { /* ignore */ }
            };

            try {
              // 1. Get direct audio URL
              console.log(`[ymd][VK_DOWNLOAD_TRACK] Getting URL for ${ownerId}_${audioId}, encryptedUrl=${payload.encryptedUrl ? "yes" : "empty"}`);
              
              let trackAudioUrl: string;
              
              if (payload.encryptedUrl && (payload.encryptedUrl as string).startsWith("https://")) {
                trackAudioUrl = payload.encryptedUrl as string;
              } else {
                // No URL — track needs to be played first in VK player
                sendResponse({ success: false, reason: "Включите трек в плеере VK и попробуйте снова" });
                return;
              }
              
              const audioResult = { url: trackAudioUrl, ownerId, audioId };

              // 2. Read format preference (content script can override via payload.preferredFormat for bulk downloads)
              const payloadFormat = (payload as { preferredFormat?: string }).preferredFormat;
              const preferredFormat: AudioFormat =
                payloadFormat === "mp3" || payloadFormat === "flac" || payloadFormat === "wav"
                  ? payloadFormat
                  : (await getServiceFormatPreferences("vk")).singleTrackFormat;

              // 3. Get audio data (MP3 bytes)
              const trackUrl = audioResult.url;
              let audioDataB64: string;
              let strategy: "direct" | "hls_demux" = "direct";

              if (trackAudioUrl.includes(".m3u8") || trackAudioUrl.includes("/index.m3u8")) {
                // HLS stream — download and demux segments
                const { downloadVkHlsTrack } = await import("./vk-hls-downloader");

                // HLS download + TS demux. Progress 0–100% reported via callback.
                const hlsResult = await downloadVkHlsTrack(trackAudioUrl, buildVkFilename({
                  artist: artist || "Unknown",
                  title: title || `audio_${audioId}`,
                  ownerId,
                  audioId,
                  ext: "mp3",
                }), sendProgress);
                audioDataB64 = hlsResult.audioDataB64;
                strategy = hlsResult.strategy;
              } else {
                // Direct mp3 URL — fetch as bytes. No streaming progress
                // available without ReadableStream parsing, so we report
                // a 0/50/100 mini-arc to keep the UI honest.
                sendProgress(5);
                const audioResp = await fetch(trackAudioUrl);
                if (!audioResp.ok) {
                  sendResponse({ success: false, reason: `Ошибка скачивания: HTTP ${audioResp.status}` });
                  return;
                }
                sendProgress(50);
                const audioBytes = new Uint8Array(await audioResp.arrayBuffer());
                sendProgress(95);
                audioDataB64 = bytesToBase64(audioBytes);
                sendProgress(100);
              }

              // 4. Convert to preferred format (fallback to MP3 on error)
              const mp3Bytes = base64ToBytes(audioDataB64);
              const convResult = await convertVkAudio(mp3Bytes, preferredFormat, {
                artist: artist || "Unknown",
                title: title || `audio_${audioId}`,
              });

              // 5. Build filename with actual extension from conversion result
              const baseFilename = buildVkFilename({
                artist: artist || "Unknown",
                title: title || `audio_${audioId}`,
                ownerId,
                audioId,
                ext: convResult.ext,
              });
              // If playlistFolder is provided, put file in subfolder
              const playlistFolder = (payload as { playlistFolder?: string }).playlistFolder;
              const filename = playlistFolder ? `${playlistFolder}/${baseFilename}` : baseFilename;

              // If we have a playlist folder, save via chrome.downloads (supports subfolders)
              // Otherwise return audioDataB64 for content script to save
              if (playlistFolder) {
                try {
                  const dataUrl = `data:application/octet-stream;base64,${convResult.audioDataB64}`;
                  const downloadId = await chrome.downloads.download({
                    url: dataUrl,
                    filename,
                    conflictAction: "uniquify",
                  });
                  sendResponse({
                    success: true,
                    downloadId,
                    filename,
                    actualFormat: convResult.ext,
                    fallbackReason: convResult.fallbackReason,
                    strategy,
                  });
                } catch (dlErr: any) {
                  // Fallback: return data for content script
                  sendResponse({
                    success: true,
                    audioDataB64: convResult.audioDataB64,
                    filename: baseFilename,
                    actualFormat: convResult.ext,
                    fallbackReason: convResult.fallbackReason,
                    strategy,
                  });
                }
              } else {
                sendResponse({
                  success: true,
                  audioDataB64: convResult.audioDataB64,
                  filename,
                  actualFormat: convResult.ext,
                  fallbackReason: convResult.fallbackReason,
                  strategy,
                });
              }
            } catch (error) {
              if (error instanceof VkApiError) {
                sendResponse({
                  success: false,
                  reason: error.message,
                  errorCode: error.code,
                });
                return;
              }
              throw error;
            }
            return;
          }

          case "VK_DOWNLOAD_PLAYLIST": {
            const payload = (
              message as {
                payload?: { tracks?: VkTrackMeta[]; playlistTitle?: string };
              }
            ).payload;

            if (!payload || !Array.isArray(payload.tracks)) {
              sendResponse({ success: false, reason: "Invalid VK playlist payload" });
              return;
            }

            const { tracks, playlistTitle } = payload;
            const total = tracks.length;
            let downloaded = 0;
            let skipped = 0;

            // Read format preference for bulk
            const vkBulkPrefs = await getServiceFormatPreferences("vk");
            const bulkPreferredFormat = vkBulkPrefs.bulkFormat;

            for (const track of tracks) {
              try {
                // Get direct audio URL (rate limiter delay handled inside vkApiClient)
                const audioResult = await vkApiClient.getAudioUrl(
                  track.ownerId,
                  track.audioId,
                );

                // Build filename (optionally under playlist folder)
                const filename = buildVkFilename({
                  artist: track.artist || "Unknown",
                  title: track.title || `audio_${track.audioId}`,
                  ownerId: track.ownerId,
                  audioId: track.audioId,
                  ext: "mp3",
                });

                // Download — direct URL or HLS
                const downloadPath = playlistTitle
                  ? `${playlistTitle.replace(/[\\/:*?"<>|]/g, "_")}/${filename}`
                  : filename;
                const clampedPath = clampDownloadPath(downloadPath);

                if (audioResult.url.includes(".m3u8")) {
                  const { downloadVkHlsTrack } = await import("./vk-hls-downloader");
                  await downloadVkHlsTrack(audioResult.url, clampedPath);
                } else {
                  // Fetch bytes first to avoid redirect filename issues
                  const audioResp = await fetch(audioResult.url);
                  if (!audioResp.ok) throw new Error(`HTTP ${audioResp.status}`);
                  const audioBytes = new Uint8Array(await audioResp.arrayBuffer());
                  const dataUrl = `data:audio/mpeg;base64,` + bytesToBase64(audioBytes);
                  await chrome.downloads.download({
                    url: dataUrl,
                    filename: clampedPath,
                    conflictAction: "uniquify",
                  });
                }

                downloaded++;
              } catch (error) {
                // On individual failure — skip and continue
                skipped++;
                console.warn(
                  `[ymd][vk-playlist] Skipping track ${track.ownerId}_${track.audioId}:`,
                  error instanceof Error ? error.message : error,
                );
              }
            }

            sendResponse({
              success: true,
              progress: { downloaded, total, skipped },
              actualFormat: "mp3",
              fallbackReason:
                bulkPreferredFormat !== "mp3"
                  ? `VK отдаёт только mp3. Запрошенный формат ${bulkPreferredFormat} недоступен.`
                  : undefined,
            });
            return;
          }

          case "YT_DOWNLOAD_VIDEO": {
            // SABR-replay flow. The content script captured nothing —
            // bytes come from the SW's `chrome.webRequest` hook (see
            // `background.ts`), where every player POST to
            // `googlevideo.com/videoplayback` is recorded per-tab. The
            // handler:
            //   1. Reads `globalThis.__ytSabrUrls` / `__ytSabrBodies`
            //      for the sender tab.
            //   2. Picks audio + video iTags via `parseAvailableStreams`
            //      and the user's preferred quality.
            //   3. Replays bodies through `downloadVideoViaSabr` —
            //      result is a fully-muxed MP4 (mediabunny in the SW).
            //   4. Saves through `downloadViaOffscreenChunked`.
            //
            // No bytes round-trip from the content script to the SW —
            // the legacy MSE-buffer scrape was only ever an emergency
            // workaround. Captured bodies replay deterministically.
            console.log(
              "[ymd][yt][YT_DOWNLOAD_VIDEO] received from content-script",
            );
            const payload = (
              message as {
                payload?: {
                  videoId?: unknown;
                  url?: unknown;
                  title?: unknown;
                  durationSec?: unknown;
                };
              }
            ).payload;

            const videoId = payload?.videoId;
            const rawTitle = payload?.title;
            const rawDurationSec = payload?.durationSec;

            if (typeof videoId !== "string" || videoId.length === 0) {
              sendResponse({ success: false, reason: "No videoId in payload" });
              return;
            }

            const title =
              typeof rawTitle === "string" && rawTitle.trim().length > 0
                ? rawTitle.trim()
                : "youtube_video";
            const durationSec =
              typeof rawDurationSec === "number" && rawDurationSec > 0
                ? rawDurationSec
                : undefined;

            const senderTabId = _sender.tab?.id;

            interface SabrGlobals {
              __ytSabrUrls?: Map<number, string[]>;
              __ytSabrBodies?: Map<number, ArrayBuffer[]>;
              __ytSabrAllBodies?: ArrayBuffer[];
              __ytVideoDurationSec?: number;
            }
            const sabrGlobals = globalThis as unknown as SabrGlobals;
            const sabrUrls =
              senderTabId !== undefined
                ? sabrGlobals.__ytSabrUrls?.get(senderTabId)
                : undefined;
            const sabrBodies =
              senderTabId !== undefined
                ? sabrGlobals.__ytSabrBodies?.get(senderTabId)
                : undefined;

            if (!sabrUrls || sabrUrls.length === 0 || !sabrBodies || sabrBodies.length === 0) {
              console.log("[ymd][yt][YT_DOWNLOAD_VIDEO] no SABR session for tab", senderTabId);
              sendResponse({
                success: false,
                errorCode: "NO_SABR_SESSION",
                reason:
                  "Сначала включите воспроизведение видео, затем нажмите «Скачать».",
              });
              return;
            }

            const baseUrl = sabrUrls[sabrUrls.length - 1];
            console.log(
              `[ymd][yt][YT_DOWNLOAD_VIDEO] tab=${senderTabId} bodies=${sabrBodies.length} urlPrefix=${baseUrl.substring(0, 100)}…`,
            );

            try {
              const { parseAvailableStreams, selectVideoStream, selectAudioStream } =
                await import("./yt-stream-selector");
              const { downloadVideoViaSabr, detectInitSegment } = await import(
                "./yt-sabr-downloader"
              );
              const { getPreferredQuality, QUALITY_ORDER } = await import(
                "../shared/yt-quality-storage"
              );
              const { downloadViaOffscreenChunked } = await import("./offscreen-bridge");

              const available = parseAvailableStreams(sabrBodies);
              console.log(
                `[ymd][yt][YT_DOWNLOAD_VIDEO] available streams: audio=[${available.audio.map((s) => s.itag).join(",")}] video=[${available.video.map((s) => s.itag).join(",")}]`,
              );

              const preferredQuality = await getPreferredQuality();
              const preferredHeight = QUALITY_ORDER[preferredQuality];
              console.log(
                `[ymd][yt][YT_DOWNLOAD_VIDEO] preferred quality: ${preferredQuality} (${preferredHeight}px)`,
              );

              const videoStream = selectVideoStream(
                available.video,
                preferredHeight,
              );
              const audioStream = selectAudioStream(available.audio);

              if (!videoStream) {
                sendResponse({
                  success: false,
                  errorCode: "NO_VIDEO_STREAM",
                  reason: "Нет подходящего видеопотока",
                });
                return;
              }
              if (!audioStream) {
                sendResponse({
                  success: false,
                  errorCode: "NO_AUDIO_STREAM",
                  reason: "Нет подходящего аудиопотока",
                });
                return;
              }

              console.log(
                `[ymd][yt][YT_DOWNLOAD_VIDEO] selected video itag=${videoStream.itag} audio itag=${audioStream.itag}`,
              );

              // Pass parameters via globals (legacy contract — see the
              // 22 May build's downloadVideoViaSabr).
              sabrGlobals.__ytSabrAllBodies = Array.from(sabrBodies);
              if (durationSec !== undefined) {
                sabrGlobals.__ytVideoDurationSec = durationSec;
              } else {
                sabrGlobals.__ytVideoDurationSec = undefined;
              }

              const result = await downloadVideoViaSabr(
                baseUrl,
                sabrBodies[0],
                videoStream,
                audioStream,
                (progress) => {
                  if (
                    progress.stream === "video" &&
                    typeof progress.pct === "number" &&
                    senderTabId !== undefined
                  ) {
                    try {
                      void chrome.tabs
                        .sendMessage(senderTabId, {
                          type: "YT_DOWNLOAD_PROGRESS",
                          payload: {
                            videoId,
                            pct: progress.pct,
                            videoBlocks: progress.videoBlocks,
                            expectedVideoBlocks: progress.expectedVideoBlocks,
                            phase: "download",
                          },
                        })
                        .catch(() => {
                          /* tab gone */
                        });
                    } catch {
                      /* ignore */
                    }
                  }
                },
              );

              // mux-99 progress tick — final tick is sent on success.
              if (senderTabId !== undefined) {
                try {
                  void chrome.tabs
                    .sendMessage(senderTabId, {
                      type: "YT_DOWNLOAD_PROGRESS",
                      payload: { videoId, pct: 99, phase: "mux" },
                    })
                    .catch(() => {});
                } catch {
                  /* ignore */
                }
              }

              if (!result.success || !result.data) {
                console.log(
                  `[ymd][yt][YT_DOWNLOAD_VIDEO] SABR download failed: ${result.success ? "no data" : result.error}`,
                );
                sendResponse({
                  success: false,
                  errorCode: "DOWNLOAD_FAILED",
                  reason: result.success ? "Не удалось собрать видео" : result.error,
                });
                return;
              }

              // The mux output is always MP4 (mediabunny + Mp4OutputFormat).
              // We still surface the raw container detection for parity
              // with the legacy build in case future variants emit WebM.
              const detected = detectInitSegment(result.data);
              const ext = detected.format === "webm" ? ".webm" : ".mp4";
              const mime = detected.format === "webm" ? "video/webm" : "video/mp4";
              const filename = `${buildYtFilename(title)}${ext}`;

              console.log(
                `[ymd][yt][YT_DOWNLOAD_VIDEO] saving via chunked offscreen: ${filename}, size=${result.totalSize}`,
              );
              const dlRes = await downloadViaOffscreenChunked(result.data, mime, filename);

              if (!dlRes.success) {
                console.error(
                  `[ymd][yt][YT_DOWNLOAD_VIDEO] chunked save failed: ${dlRes.reason}`,
                );
                sendResponse({
                  success: false,
                  errorCode: "DOWNLOAD_FAILED",
                  reason: dlRes.reason || "Не удалось сохранить файл",
                });
                return;
              }

              if (senderTabId !== undefined) {
                try {
                  void chrome.tabs
                    .sendMessage(senderTabId, {
                      type: "YT_DOWNLOAD_PROGRESS",
                      payload: { videoId, pct: 100, phase: "mux" },
                    })
                    .catch(() => {});
                } catch {
                  /* ignore */
                }
              }

              sendResponse({
                success: true,
                downloadId: dlRes.downloadId,
                filename,
              });
              return;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error("[ymd][yt][YT_DOWNLOAD_VIDEO] error:", err);
              sendResponse({
                success: false,
                errorCode: "DOWNLOAD_ERROR",
                reason: `Ошибка скачивания: ${msg}`,
              });
              return;
            }
          }

          case "SPOTIFY_DOWNLOAD_TRACK": {
            // Скачивание одиночного Spotify-трека (см.
            // .kiro/specs/spotify-mp3-download/design.md). У каждой сессии —
            // свой sessionId и свой AbortController внутри
            // handleSpotifyDownload, никакого глобального лока (R14.5).
            // Прогрессовые сообщения SPOTIFY_DOWNLOAD_PROGRESS оркестратор
            // шлёт сам в sender-вкладку через chrome.tabs.sendMessage.
            const payload = (
              message as {
                payload?: { sessionId?: unknown; trackMeta?: unknown };
              }
            ).payload;

            // Минимальная валидация формы payload — без неё handler
            // упадёт на первом же шаге пайплайна с менее информативным
            // сообщением.
            const sessionId =
              typeof payload?.sessionId === "string" ? payload.sessionId : "";
            const trackMeta = payload?.trackMeta as
              | { trackId?: unknown }
              | undefined;
            const trackId =
              trackMeta && typeof trackMeta.trackId === "string"
                ? trackMeta.trackId
                : "";

            if (sessionId.length === 0 || trackId.length === 0) {
              sendResponse({
                success: false,
                errorCode: "SPOTIFY_TRACK_ID_INVALID",
                reason:
                  "Некорректный payload SPOTIFY_DOWNLOAD_TRACK: отсутствует sessionId или trackMeta.trackId",
                ...(sessionId.length > 0 ? { sessionId } : {}),
              });
              return;
            }

            const response = await handleSpotifyDownload(
              message as SpotifyDownloadMessage,
              _sender,
            );
            sendResponse(response);
            return;
          }

          default: {
            sendResponse({
              success: false,
              reason: "Unknown message type",
            });
            return;
          }
        }
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          sendResponse({
            success: false,
            errorCode: "AUTH_REQUIRED",
            reason:
              "Расширение не авторизовано или токен устарел. Откройте popup и нажмите «Подключить аккаунт».",
          });
          return;
        }
        if (
          error instanceof ApiPreviewOnlyError ||
          error instanceof ResolverPreviewOnlyError
        ) {
          sendResponse({
            success: false,
            errorCode: "PREVIEW_ONLY",
            reason: error.message,
          });
          return;
        }
        if (error instanceof DrmProtectedError) {
          sendResponse({
            success: false,
            errorCode: "DRM_PROTECTED",
            reason: "Трек недоступен для скачивания",
          });
          return;
        }

        logError("message-router", error);
        const errorCode = classifyError(error);
        sendResponse({
          success: false,
          reason: error instanceof Error ? error.message : "Unknown error",
          errorCode,
        });
      }
    })();

    return true;
  };
}
