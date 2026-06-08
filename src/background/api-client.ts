// Yandex Music API client.
//
// Использует endpoint api.music.yandex.net/tracks/{id}/download-info
// с OAuth-токеном в заголовке.

import { ApiError, TimeoutError } from "./error-classifier";
import { md5 } from "../shared/md5";
import { getStoredToken } from "../shared/auth";

const API_BASE = "https://api.music.yandex.net";
const HANDLERS_BASE = "https://music.yandex.ru/handlers";
const API_TIMEOUT_MS = 30_000;
const SALT = "XGRlBW9FXlekgbPrRHuSiA";

interface DownloadInfo {
  codec: string;
  preview?: boolean;
  bitrateInKbps: number;
  downloadInfoUrl: string;
  /**
   * Уже подписанный прямой URL аудиофайла. Заполняется только записями из
   * нового endpoint /get-file-info — там сервер сразу отдаёт готовую ссылку,
   * без отдельного XML-запроса. Если поле задано, getSignedUrlFromEntry
   * возвращает его как есть.
   */
  directUrl?: string;
}

interface DownloadInfoResponse {
  result: DownloadInfo[];
}

export class DrmProtectedError extends Error {
  constructor(message = "DRM_PROTECTED") {
    super(message);
    this.name = "DrmProtectedError";
    Object.setPrototypeOf(this, DrmProtectedError.prototype);
  }
}

export class AuthRequiredError extends Error {
  constructor(message = "AUTH_REQUIRED") {
    super(message);
    this.name = "AuthRequiredError";
    Object.setPrototypeOf(this, AuthRequiredError.prototype);
  }
}

export class PreviewOnlyError extends Error {
  constructor(message = "PREVIEW_ONLY") {
    super(message);
    this.name = "PreviewOnlyError";
    Object.setPrototypeOf(this, PreviewOnlyError.prototype);
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getStoredToken();
  if (token === null) {
    throw new AuthRequiredError("Расширение не авторизовано");
  }
  return {
    Authorization: `OAuth ${token}`,
    "X-Yandex-Music-Client": "YandexMusicAndroid/24023621",
  };
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new TimeoutError("API timeout")), ms);
  });
  try {
    return await Promise.race([p, timer]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

function apiErrorForStatus(status: number, body?: string): Error {
  if (status === 401 || status === 403) {
    return new AuthRequiredError(`HTTP ${status}: ${body?.slice(0, 200) ?? ""}`);
  }
  return new ApiError(status, `HTTP ${status}: ${body?.slice(0, 200) ?? ""}`);
}

/**
 * Метаданные трека.
 */
export interface TrackInfo {
  trackId: string;
  albumId: string | null;
  artist: string;
  title: string;
  albumTitle: string | null;
  year: string | null;
  trackNumber: string | null;
  coverUri: string | null;
}

/**
 * Получает метаданные трека.
 *
 * Стратегия (порядок проверен в твоей сессии):
 *   1. GET api.music.yandex.net/tracks/{id} с OAuth → result[0] с title и artists.
 *   2. GET api.music.yandex.net/tracks?trackIds={id} с OAuth.
 *   3. handlers/track.jsx через куки.
 *   4. Заглушка.
 */
export async function getTrackInfo(trackId: string): Promise<TrackInfo> {
  type T = {
    id?: string | number;
    realId?: string | number;
    title?: string;
    coverUri?: string;
    artists?: Array<{ name?: string; cover?: { uri?: string } }>;
    albums?: Array<{
      id?: string | number;
      title?: string;
      year?: number;
      trackPosition?: { volume?: number; index?: number };
      coverUri?: string;
    }>;
  };

  const headersWithToken = await authHeaders().catch(() => null);

  const buildResult = (track: T): TrackInfo => {
    const artists = (track.artists ?? [])
      .map((a) => a?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    const album = Array.isArray(track.albums) ? track.albums[0] : undefined;
    const albumId =
      album?.id !== undefined && album.id !== null ? String(album.id) : null;
    const albumTitle =
      typeof album?.title === "string" && album.title.length > 0
        ? album.title
        : null;
    const year =
      typeof album?.year === "number" && album.year > 0
        ? String(album.year)
        : null;
    const trackNumber =
      album?.trackPosition?.index !== undefined &&
      album.trackPosition.index !== null
        ? String(album.trackPosition.index)
        : null;
    const coverUri =
      typeof track.coverUri === "string" && track.coverUri.length > 0
        ? track.coverUri
        : typeof album?.coverUri === "string" && album.coverUri.length > 0
          ? album.coverUri
          : null;
    return {
      trackId: String(track.realId ?? track.id ?? trackId),
      albumId,
      artist: artists.length > 0 ? artists.join(", ") : "Unknown",
      title:
        typeof track.title === "string" && track.title.length > 0
          ? track.title
          : `track-${trackId}`,
      albumTitle,
      year,
      trackNumber,
      coverUri,
    };
  };

  // 1. GET /tracks/{id} — самый надёжный.
  if (headersWithToken !== null) {
    try {
      const resp = await withTimeout(
        fetch(`${API_BASE}/tracks/${trackId}`, { headers: headersWithToken }),
        API_TIMEOUT_MS,
      );
      if (resp.ok) {
        const data = (await resp.json()) as { result?: T[] | T };
        const track = Array.isArray(data.result)
          ? data.result[0]
          : (data.result as T | undefined);
        if (track !== undefined) {
          return buildResult(track);
        }
      } else {
        console.warn("[ymd][getTrackInfo] GET /tracks/{id}", resp.status);
      }
    } catch (e) {
      console.warn("[ymd][getTrackInfo] GET /tracks/{id} threw:", e);
    }
  }

  // 2. GET /tracks?trackIds.
  if (headersWithToken !== null) {
    try {
      const resp = await withTimeout(
        fetch(`${API_BASE}/tracks?trackIds=${trackId}`, {
          headers: headersWithToken,
        }),
        API_TIMEOUT_MS,
      );
      if (resp.ok) {
        const data = (await resp.json()) as { result?: T[] };
        const track = Array.isArray(data.result) ? data.result[0] : undefined;
        if (track !== undefined) {
          return buildResult(track);
        }
      } else {
        console.warn(
          "[ymd][getTrackInfo] GET /tracks?trackIds=",
          resp.status,
        );
      }
    } catch (e) {
      console.warn("[ymd][getTrackInfo] GET /tracks?trackIds threw:", e);
    }
  }

  // 3. handlers/track.jsx через куки.
  try {
    const resp = await withTimeout(
      fetch(`${HANDLERS_BASE}/track.jsx?track=${trackId}`, {
        credentials: "include",
        headers: {
          "X-Retpath-Y": "https://music.yandex.ru/",
          Accept: "application/json",
        },
      }),
      API_TIMEOUT_MS,
    );
    if (resp.ok) {
      const data = (await resp.json()) as { track?: T };
      if (data.track !== undefined) {
        return buildResult(data.track);
      }
    }
  } catch (e) {
    console.warn("[ymd][getTrackInfo] handlers/track.jsx threw:", e);
  }

  // 4. Заглушка.
  return {
    trackId,
    albumId: null,
    artist: "Unknown",
    title: `track-${trackId}`,
    albumTitle: null,
    year: null,
    trackNumber: null,
    coverUri: null,
  };
}

/**
 * Получить метаданные альбома (включая список треков).
 */
type SearchApiTrack = {
  id?: string | number;
  realId?: string | number;
  title?: string;
  coverUri?: string;
  artists?: Array<{ name?: string }>;
  albums?: Array<{
    id?: string | number;
    title?: string;
    year?: number;
    trackPosition?: { index?: number };
    coverUri?: string;
  }>;
};

function normalizeSearchText(text: string): string {
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

function tokenizeSearchText(text: string): string[] {
  return normalizeSearchText(text)
    .split(" ")
    .filter((token) => token.length > 0);
}

function buildSearchTrackInfo(track: SearchApiTrack): TrackInfo | null {
  const rawId = track.realId ?? track.id;
  if (rawId === undefined || rawId === null) return null;
  const artists = (track.artists ?? [])
    .map((a) => a?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  const album = Array.isArray(track.albums) ? track.albums[0] : undefined;
  const albumId =
    album?.id !== undefined && album.id !== null ? String(album.id) : null;
  return {
    trackId: String(rawId),
    albumId,
    artist: artists.length > 0 ? artists.join(", ") : "Unknown",
    title:
      typeof track.title === "string" && track.title.length > 0
        ? track.title
        : `track-${rawId}`,
    albumTitle:
      typeof album?.title === "string" && album.title.length > 0
        ? album.title
        : null,
    year:
      typeof album?.year === "number" && album.year > 0
        ? String(album.year)
        : null,
    trackNumber:
      album?.trackPosition?.index !== undefined &&
      album.trackPosition.index !== null
        ? String(album.trackPosition.index)
        : null,
    coverUri:
      typeof track.coverUri === "string" && track.coverUri.length > 0
        ? track.coverUri
        : typeof album?.coverUri === "string" && album.coverUri.length > 0
          ? album.coverUri
          : null,
  };
}

export async function findTrackByMetadata(
  artist: string,
  title: string,
): Promise<TrackInfo | null> {
  const query = `${artist} ${title}`.trim();
  if (query.length === 0) return null;

  const headers = await authHeaders();
  const url =
    `${API_BASE}/search?` +
    `text=${encodeURIComponent(query)}` +
    "&type=track&page=0&nocorrect=false";

  const resp = await withTimeout(fetch(url, { headers }), API_TIMEOUT_MS);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw apiErrorForStatus(resp.status, body);
  }

  const data = (await resp.json()) as {
    result?: { tracks?: { results?: SearchApiTrack[] } };
  };
  const results = data.result?.tracks?.results;
  if (!Array.isArray(results) || results.length === 0) return null;

  const hintTitle = normalizeSearchText(title);
  const hintArtistTokens = tokenizeSearchText(artist);
  let best: { info: TrackInfo; score: number } | null = null;

  for (const candidate of results.slice(0, 20)) {
    const info = buildSearchTrackInfo(candidate);
    if (info === null) continue;
    if (normalizeSearchText(info.title) !== hintTitle) continue;

    const candidateArtistTokens = tokenizeSearchText(info.artist);
    const commonArtists = hintArtistTokens.filter((token) =>
      candidateArtistTokens.includes(token),
    ).length;
    if (hintArtistTokens.length > 0 && commonArtists === 0) continue;

    const score = commonArtists * 10 + (info.albumId !== null ? 1 : 0);
    if (best === null || score > best.score) best = { info, score };
  }

  return best?.info ?? null;
}

export interface AlbumTrackInfo {
  id: string;
  title: string;
}

export interface AlbumInfo {
  albumId: string;
  title: string;
  trackIds: string[];
  tracks: AlbumTrackInfo[];
}

export async function getAlbumInfo(albumId: string): Promise<AlbumInfo> {
  const headers = await authHeaders();
  const url = `${API_BASE}/albums/${albumId}/with-tracks`;
  const resp = await withTimeout(fetch(url, { headers }), API_TIMEOUT_MS);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw apiErrorForStatus(resp.status, body);
  }
  const data = (await resp.json()) as {
    result?: {
      id?: string | number;
      title?: string;
      volumes?: Array<Array<{ id?: string | number; title?: string }>>;
    };
  };
  const result = data.result;
  if (result === undefined) {
    throw new Error("Album not found");
  }
  const trackIds: string[] = [];
  const tracks: AlbumTrackInfo[] = [];
  for (const vol of result.volumes ?? []) {
    for (const t of vol) {
      if (t?.id !== undefined && t.id !== null) {
        const id = String(t.id);
        trackIds.push(id);
        tracks.push({ id, title: typeof t.title === "string" ? t.title : "" });
      }
    }
  }
  return {
    albumId: String(result.id ?? albumId),
    title: typeof result.title === "string" ? result.title : "Album",
    trackIds,
    tracks,
  };
}

export interface PlaylistInfo {
  owner: string;
  kind: string;
  title: string;
  trackIds: string[];
}

/**
 * Получить логин текущего пользователя через /account/status.
 */
async function getCurrentLogin(): Promise<string | null> {
  try {
    const headers = await authHeaders();
    const resp = await withTimeout(
      fetch(`${API_BASE}/account/status`, { headers }),
      API_TIMEOUT_MS,
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      result?: {
        account?: {
          uid?: string | number;
          login?: string;
        };
      };
    };
    const account = data.result?.account;
    if (account === undefined) return null;
    if (typeof account.uid === "string" && account.uid.length > 0) {
      return account.uid;
    }
    if (typeof account.uid === "number") {
      return String(account.uid);
    }
    if (typeof account.login === "string" && account.login.length > 0) {
      return account.login;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Получить все лайкнутые треки текущего пользователя.
 * Не требует знать URL плейлиста — берёт логин через /account/status.
 */
export async function getCurrentUserLikedTracks(): Promise<PlaylistInfo> {
  const headers = await authHeaders();
  const login = await getCurrentLogin();
  if (login === null) {
    throw new Error("Не удалось определить логин аккаунта");
  }
  const url = `${API_BASE}/users/${encodeURIComponent(login)}/likes/tracks`;
  const resp = await withTimeout(fetch(url, { headers }), API_TIMEOUT_MS);
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    result?: {
      library?: {
        tracks?: Array<{ id?: string | number; albumId?: string | number }>;
      };
      tracks?: Array<{
        id?: string | number;
        track?: { id?: string | number };
      }>;
    };
  };
  const result = data.result;
  const trackIds: string[] = [];
  if (result !== undefined) {
    const libTracks = result.library?.tracks;
    if (Array.isArray(libTracks)) {
      for (const t of libTracks) {
        if (t?.id !== undefined && t.id !== null) {
          trackIds.push(String(t.id));
        }
      }
    }
    if (trackIds.length === 0 && Array.isArray(result.tracks)) {
      for (const t of result.tracks) {
        const id = t?.track?.id ?? t?.id;
        if (id !== undefined && id !== null) {
          trackIds.push(String(id));
        }
      }
    }
  }
  return {
    owner: login,
    kind: "3",
    title: "Мне нравится",
    trackIds,
  };
}

/**
 * Получить кастомный плейлист по URL вида /playlists/lk.{uuid}.
 * Это новая схема Я.Музыки 2024+.
 */
export async function getPlaylistByUuid(uuid: string): Promise<PlaylistInfo> {
  const headers = await authHeaders();
  // Новый endpoint для UUID-плейлистов
  const candidates = [
    `${API_BASE}/playlist/${encodeURIComponent(uuid)}`,
    `${API_BASE}/playlists/${encodeURIComponent(uuid)}`,
    `${API_BASE}/playlists?playlistIds=${encodeURIComponent(uuid)}`,
  ];
  for (const url of candidates) {
    try {
      const resp = await withTimeout(fetch(url, { headers }), API_TIMEOUT_MS);
      if (!resp.ok) continue;
      const data = (await resp.json()) as {
        result?:
          | {
              title?: string;
              uid?: string | number;
              owner?: { login?: string };
              tracks?: Array<{
                id?: string | number;
                track?: { id?: string | number };
              }>;
            }
          | Array<{
              title?: string;
              uid?: string | number;
              owner?: { login?: string };
              tracks?: Array<{
                id?: string | number;
                track?: { id?: string | number };
              }>;
            }>;
      };
      const result = Array.isArray(data.result)
        ? data.result[0]
        : data.result;
      if (result === undefined) continue;
      const trackIds: string[] = [];
      for (const t of result.tracks ?? []) {
        const id = t?.track?.id ?? t?.id;
        if (id !== undefined && id !== null) {
          trackIds.push(String(id));
        }
      }
      if (trackIds.length === 0) continue;
      return {
        owner: result.owner?.login ?? "unknown",
        kind: uuid,
        title:
          typeof result.title === "string" && result.title.length > 0
            ? result.title
            : "Playlist",
        trackIds,
      };
    } catch {
      // Пробуем следующий вариант.
    }
  }
  throw new Error(
    `Плейлист lk.${uuid} не удалось получить через API. Прокрутите страницу до конца — расширение возьмёт треки из DOM.`,
  );
}

export async function getPlaylistInfo(
  owner: string,
  kind: string,
): Promise<PlaylistInfo> {
  const headers = await authHeaders();

  const tryPlaylist = async (): Promise<PlaylistInfo | null> => {
    const url = `${API_BASE}/users/${encodeURIComponent(owner)}/playlists/${encodeURIComponent(kind)}`;
    const resp = await withTimeout(fetch(url, { headers }), API_TIMEOUT_MS);
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      result?: {
        title?: string;
        tracks?: Array<{
          id?: string | number;
          track?: { id?: string | number };
        }>;
      };
    };
    const result = data.result;
    if (result === undefined) return null;
    const trackIds: string[] = [];
    for (const t of result.tracks ?? []) {
      const id = t?.track?.id ?? t?.id;
      if (id !== undefined && id !== null) {
        trackIds.push(String(id));
      }
    }
    if (trackIds.length === 0) return null;
    return {
      owner,
      kind,
      title: typeof result.title === "string" ? result.title : "Playlist",
      trackIds,
    };
  };

  const tryLikes = async (): Promise<PlaylistInfo | null> => {
    const url = `${API_BASE}/users/${encodeURIComponent(owner)}/likes/tracks`;
    const resp = await withTimeout(fetch(url, { headers }), API_TIMEOUT_MS);
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      result?: {
        library?: {
          tracks?: Array<{
            id?: string | number;
            albumId?: string | number;
          }>;
        };
        // Альтернативные структуры:
        tracks?: Array<{
          id?: string | number;
          track?: { id?: string | number };
        }>;
      };
    };
    const result = data.result;
    if (result === undefined) return null;

    const trackIds: string[] = [];

    // Вариант 1: result.library.tracks[].id
    const libTracks = result.library?.tracks;
    if (Array.isArray(libTracks)) {
      for (const t of libTracks) {
        if (t?.id !== undefined && t.id !== null) {
          trackIds.push(String(t.id));
        }
      }
    }

    // Вариант 2: result.tracks[].id или result.tracks[].track.id
    if (trackIds.length === 0 && Array.isArray(result.tracks)) {
      for (const t of result.tracks) {
        const id = t?.track?.id ?? t?.id;
        if (id !== undefined && id !== null) {
          trackIds.push(String(id));
        }
      }
    }

    if (trackIds.length === 0) return null;
    return {
      owner,
      kind,
      title: "Мне нравится",
      trackIds,
    };
  };

  // Для kind=3 ("Мне нравится") приоритет — likes endpoint.
  if (kind === "3") {
    const likes = await tryLikes().catch(() => null);
    if (likes !== null) return likes;
  }
  const playlist = await tryPlaylist().catch(() => null);
  if (playlist !== null) return playlist;
  // Фолбэк на лайки даже если kind не "3" — на всякий случай.
  if (kind !== "3") {
    const likes = await tryLikes().catch(() => null);
    if (likes !== null) return likes;
  }
  throw new Error(
    `Плейлист пуст или недоступен (owner=${owner}, kind=${kind})`,
  );
}

interface XmlParts {
  host: string;
  path: string;
  s: string;
  ts: string;
}

function extractTag(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (m === null) return null;
  return m[1].trim();
}

function parseDownloadInfoXml(xml: string): XmlParts {
  const host = extractTag(xml, "host");
  const path = extractTag(xml, "path");
  const ts = extractTag(xml, "ts");
  const s = extractTag(xml, "s");
  if (host === null || path === null || ts === null || s === null) {
    throw new Error(
      `Missing required XML field. Body: ${xml.slice(0, 200)}`,
    );
  }
  return { host, path, ts, s };
}

/**
 * Map codec → URL prefix segment expected by the Yandex storage host.
 * MP3:   /get-mp3/...
 * FLAC:  /get-flac/...
 * AAC:   /get-mp4a/...
 *
 * Использовать неправильный префикс приведёт к 404 даже если подпись валидна.
 */
function urlPrefixForCodec(codec: string): string {
  const c = codec.toLowerCase();
  if (c === "flac") return "get-flac";
  if (c === "aac") return "get-mp4a";
  // mp3 и неизвестные кодеки — fallback на mp3 (наиболее частый).
  return "get-mp3";
}

function buildSignedUrl(parts: XmlParts, codec: string): string {
  const pathForHash = parts.path.startsWith("/")
    ? parts.path.substring(1)
    : parts.path;
  const sign = md5(SALT + pathForHash + parts.s);
  const prefix = urlPrefixForCodec(codec);
  return `https://${parts.host}/${prefix}/${sign}/${parts.ts}${parts.path}`;
}

function pickBest(infos: DownloadInfo[]): DownloadInfo {
  const nonPreview = infos.filter((i) => i.preview !== true);
  const pool = nonPreview.length > 0 ? nonPreview : infos;
  const mp3 = pool.filter((i) => i.codec === "mp3");
  const final = mp3.length > 0 ? mp3 : pool;
  let best = final[0];
  for (let i = 1; i < final.length; i++) {
    if (final[i].bitrateInKbps > best.bitrateInKbps) best = final[i];
  }
  return best;
}

/**
 * Запросить расширенный download-info через новый endpoint /get-file-info.
 * Этот endpoint используется официальным Web/Android клиентом и возвращает
 * lossless варианты (FLAC), которых нет в legacy /tracks/{id}/download-info.
 *
 * Endpoint требует подписи запроса: sign = md5(SALT + ts + trackId + quality + codecs + transports).
 * В ответе уже подписанный URL аудио — повторный запрос не нужен.
 */
async function getLosslessDownloadInfo(
  trackId: string,
): Promise<DownloadInfo[]> {
  const headers = await authHeaders();

  // Параметры в фиксированном порядке — порядок важен для подписи.
  const ts = Math.floor(Date.now() / 1000).toString();
  const quality = "lossless";
  const codecs = "flac,aac,he-aac,mp3";
  const transports = "raw,encraw";

  const sign = md5(SALT + ts + trackId + quality + codecs + transports);

  const url =
    `${API_BASE}/get-file-info?` +
    `ts=${ts}` +
    `&trackId=${encodeURIComponent(trackId)}` +
    `&quality=${quality}` +
    `&codecs=${encodeURIComponent(codecs)}` +
    `&transports=${transports}` +
    `&sign=${sign}`;

  try {
    const resp = await withTimeout(fetch(url, { headers }), API_TIMEOUT_MS);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      console.warn(
        "[ymd][get-file-info] HTTP",
        resp.status,
        body.slice(0, 200),
      );
      return [];
    }
    const data = (await resp.json()) as {
      result?: {
        downloadInfo?: {
          urls?: string[];
          codec?: string;
          bitrate?: number;
          quality?: string;
        };
        // Альтернативная схема: result сразу содержит поля.
        urls?: string[];
        codec?: string;
        bitrate?: number;
      };
    };

    const di = data.result?.downloadInfo ?? data.result;
    const urls = di?.urls;
    const codec = di?.codec;
    const bitrate = di?.bitrate;

    console.info("[ymd][get-file-info] response=", {
      codec,
      bitrate,
      urlsCount: urls?.length,
      sample: urls?.[0]?.slice(0, 80),
    });

    if (!Array.isArray(urls) || urls.length === 0 || typeof codec !== "string") {
      return [];
    }

    // Первый URL — наш прямой подписанный линк. bitrate в kbps уже.
    return [
      {
        codec,
        bitrateInKbps: typeof bitrate === "number" ? bitrate : 0,
        preview: false,
        downloadInfoUrl: urls[0], // поставим тот же URL для совместимости
        directUrl: urls[0],
      },
    ];
  } catch (e) {
    console.warn("[ymd][get-file-info] threw:", e);
    return [];
  }
}

/**
 * Получить полный список download-info entries для трека (все кодеки и битрейты).
 *
 * Бросает AuthRequiredError при 401/403, PreviewOnlyError если все варианты
 * preview-only, DrmProtectedError если API вернул пустой результат, ApiError
 * для прочих HTTP-ошибок. Используется новым кодом для выбора нужного формата.
 */
export async function getDownloadInfoEntries(
  trackId: string,
): Promise<DownloadInfo[]> {
  const headers = await authHeaders();

  const candidates = [
    `${API_BASE}/tracks/${trackId}/download-info`,
    `${API_BASE}/tracks/${trackId}/download-info?can_use_streaming=true`,
    `${API_BASE}/tracks/${trackId}/download-info?direct=true`,
    `${API_BASE}/tracks/${trackId}/download-info?can_use_streaming=true&direct=true`,
  ];

  let bestEntries: DownloadInfo[] | null = null;
  let lastResponseSnapshot: DownloadInfo[] | null = null;
  let lastErrorStatus = 0;
  let lastErrorBody = "";

  for (const infoUrl of candidates) {
    try {
      const infoResp = await withTimeout(
        fetch(infoUrl, { headers }),
        API_TIMEOUT_MS,
      );
      if (!infoResp.ok) {
        lastErrorStatus = infoResp.status;
        try {
          lastErrorBody = await infoResp.text();
        } catch {
          /* ignore */
        }
        if (infoResp.status === 401 || infoResp.status === 403) {
          throw new AuthRequiredError(
            `HTTP ${infoResp.status} при запросе download-info. ` +
              `Тело: ${lastErrorBody.slice(0, 200)}`,
          );
        }
        continue;
      }

      const data = (await infoResp.json()) as DownloadInfoResponse;
      if (!Array.isArray(data.result) || data.result.length === 0) continue;

      // [DEBUG] Снимок ответа для диагностики FLAC/WAV.
      console.info(
        "[ymd][download-info] candidate=",
        infoUrl,
        "entries=",
        data.result.map((e) => ({
          codec: e.codec,
          bitrate: e.bitrateInKbps,
          preview: e.preview === true,
        })),
      );

      lastResponseSnapshot = data.result;
      const nonPreview = data.result.filter((i) => i.preview !== true);
      if (nonPreview.length > 0) {
        // Возвращаем полный список (включая preview), чтобы caller мог
        // самостоятельно фильтровать. Resolver сам выбирает non-preview.
        bestEntries = data.result;
        break;
      }
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      // иначе пробуем следующий candidate
    }
  }

  if (bestEntries === null) {
    // Прежде чем падать — попробуем lossless endpoint. Он работает независимо
    // от старого /tracks/{id}/download-info и может вернуть FLAC.
    const lossless = await getLosslessDownloadInfo(trackId);
    if (lossless.length > 0) {
      console.info(
        "[ymd][download-info] legacy endpoint пустой, использую lossless:",
        lossless.map((e) => ({ codec: e.codec, bitrate: e.bitrateInKbps })),
      );
      return lossless;
    }
    if (lastResponseSnapshot !== null) {
      throw new PreviewOnlyError(
        `API возвращает только превью (${lastResponseSnapshot.length} вариантов). ` +
          "Токен не имеет прав на полные треки. Попробуйте перевыпустить токен.",
      );
    }
    if (lastErrorStatus !== 0) {
      throw apiErrorForStatus(lastErrorStatus, lastErrorBody);
    }
    throw new DrmProtectedError("download-info вернул пустой результат");
  }

  // Дополним список из legacy endpoint'а lossless вариантами (FLAC).
  // Legacy /tracks/{id}/download-info FLAC не возвращает.
  const lossless = await getLosslessDownloadInfo(trackId);
  if (lossless.length > 0) {
    // Не дублируем кодек, который уже есть в bestEntries (на случай если
    // /get-file-info внезапно отдаст mp3 вариант — приоритет за legacy).
    const existingCodecs = new Set(
      bestEntries.filter((e) => e.preview !== true).map((e) => e.codec),
    );
    for (const e of lossless) {
      if (!existingCodecs.has(e.codec)) {
        bestEntries.push(e);
      }
    }
    console.info(
      "[ymd][download-info] объединено с lossless. Итоговые entries:",
      bestEntries.map((e) => ({
        codec: e.codec,
        bitrate: e.bitrateInKbps,
        preview: e.preview === true,
        direct: e.directUrl !== undefined,
      })),
    );
  }

  return bestEntries;
}

/**
 * По выбранному download-info entry получить подписанный URL для скачивания.
 *
 * Codec обязателен для legacy-флоу — определяет URL-префикс на хосте
 * хранилища (/get-mp3/, /get-flac/, /get-mp4a/). Подпись от него не зависит,
 * но хост возвращает 404 если префикс не соответствует кодеку файла.
 *
 * Для записей из /get-file-info третьим параметром приходит `directUrl` —
 * уже подписанная ссылка, которую возвращаем как есть, без второго запроса.
 */
export async function getSignedUrlFromEntry(
  downloadInfoUrl: string,
  codec: string,
  directUrl?: string,
): Promise<string> {
  if (typeof directUrl === "string" && directUrl.length > 0) {
    console.info(
      "[ymd][signed-url] direct (lossless) codec=",
      codec,
      "→",
      directUrl.slice(0, 120) + "…",
    );
    return directUrl;
  }

  const headers = await authHeaders();
  const xmlResp = await withTimeout(
    fetch(downloadInfoUrl, { headers }),
    API_TIMEOUT_MS,
  );
  if (!xmlResp.ok) {
    const body = await xmlResp.text().catch(() => "");
    throw apiErrorForStatus(xmlResp.status, body);
  }
  const xml = await xmlResp.text();
  const parts = parseDownloadInfoXml(xml);
  const signedUrl = buildSignedUrl(parts, codec);
  // [DEBUG] Логируем итоговый URL и сырые поля XML — чтобы понять, какой
  // префикс использует хост и какой path/host пришёл.
  console.info(
    "[ymd][signed-url] codec=",
    codec,
    "host=",
    parts.host,
    "path=",
    parts.path,
    "→",
    signedUrl,
  );
  return signedUrl;
}

/**
 * Получить подписанный URL аудиофайла.
 *
 * Сохранён для обратной совместимости (использует pickBest, всегда отдаёт
 * лучший MP3). Новый код должен использовать getDownloadInfoEntries +
 * resolveFormat + getSignedUrlFromEntry.
 */
export async function getDownloadURL(trackId: string): Promise<string> {
  const entries = await getDownloadInfoEntries(trackId);
  const nonPreview = entries.filter((i) => i.preview !== true);
  const pool = nonPreview.length > 0 ? nonPreview : entries;
  if (pool.length === 0) {
    throw new DrmProtectedError("download-info вернул пустой результат");
  }
  const best = pickBest(pool);
  return getSignedUrlFromEntry(best.downloadInfoUrl, best.codec);
}
