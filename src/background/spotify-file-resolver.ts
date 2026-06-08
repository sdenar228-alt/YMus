// Резолвинг Spotify_File_Id для трека: чистая функция выбора лучшего
// доступного OGG-Vorbis-формата.
// Реализует Requirements 6.3–6.6 и 20.1–20.7 (см. requirements.md, design § H).
//
// В этом файле сейчас живёт только чистая часть — никаких импортов из
// chrome.* и никаких сетевых запросов. Сетевая функция fetchTrackFiles,
// обращающаяся к https://spclient.wg.spotify.com/metadata/4/track/{gid},
// добавляется отдельной задачей (см. tasks.md § 3.4) и подключит сюда
// trackIdToGid + общий механизм SpotifyError/таймаутов.

import type { SpotifyFormatEntry } from "../shared/spotify-types";

/**
 * Приоритет OGG-Vorbis-форматов от лучшего к худшему (Requirement 6.4).
 *
 * Порядок строго детерминирован и не зависит от порядка элементов на входе:
 * сначала ищем 320, затем 160, затем 96. При наличии нескольких записей
 * одного формата `Array.prototype.find` вернёт первую — это требуется
 * Requirement 6.4 ("при наличии нескольких записей одного формата —
 * первую в списке").
 */
export const OGG_PRIORITY = [
  "OGG_VORBIS_320",
  "OGG_VORBIS_160",
  "OGG_VORBIS_96",
] as const;

/**
 * Результат `selectBestFormat`. Discriminated union по полю `kind`:
 * - `{ kind: "ogg", entry }` — выбран конкретный OGG-Vorbis-файл,
 *   `entry.format` гарантированно входит в `OGG_PRIORITY`.
 * - `{ kind: "drm" }` — среди входов нет ни одной OGG-записи; вызывающий
 *   код обязан вернуть пользователю `SPOTIFY_DRM_PROTECTED` (Requirement 6.7).
 *
 * MP4_*-форматы и любые прочие нестандартные литералы трактуются строго
 * как DRM (Requirement 6.6, 20.6) — они никогда не попадают в `kind: "ogg"`.
 */
export type SelectBestFormatResult =
  | { kind: "ogg"; entry: SpotifyFormatEntry }
  | { kind: "drm" };

/**
 * Чистая функция выбора лучшего доступного OGG-Vorbis-формата трека.
 *
 * Алгоритм (Requirements 6.3–6.6, 20.1–20.7):
 * 1. Линейный проход по `OGG_PRIORITY` от лучшего к худшему.
 * 2. На каждой итерации `formats.find(f => f.format === target)` — берём
 *    первую запись соответствующего формата и сразу возвращаемся.
 * 3. Если ни один из приоритетных форматов не нашёлся — возвращаем
 *    `{ kind: "drm" }` (Requirement 6.5).
 *
 * Инварианты:
 * - Никогда не возвращает запись с `format`, начинающимся на `MP4_`,
 *   как `{ kind: "ogg", … }` (Requirement 6.6, 20.6): `OGG_PRIORITY`
 *   содержит только OGG-литералы, поэтому `f.format === target` для
 *   MP4_*-записей не выполняется ни на одной итерации.
 * - Детерминированна: для одного и того же входа всегда возвращает один
 *   и тот же результат (Requirement 20.7).
 * - Чистая: не имеет побочных эффектов и не модифицирует входной массив.
 *
 * Validates: Requirements 6.3, 6.4, 6.5, 6.6, 20.1, 20.2, 20.3, 20.4,
 * 20.5, 20.6, 20.7.
 */
export function selectBestFormat(
  formats: ReadonlyArray<SpotifyFormatEntry>,
): SelectBestFormatResult {
  for (const target of OGG_PRIORITY) {
    const hit = formats.find((f) => f.format === target);
    if (hit !== undefined) return { kind: "ogg", entry: hit };
  }
  return { kind: "drm" };
}

// ─── Сетевой слой: fetchTrackFiles ─────────────────────────────────────────
//
// Обращение к внутреннему metadata-эндпоинту Spotify
// `https://spclient.wg.spotify.com/metadata/4/track/{trackGid}` (R6.1).
//
// Возвращает плоский список пар `(format, fileId)` из основной записи
// `audio_files` и из всех `alternatives[].audio_files` (R6.2). Чистая
// функция выбора лучшего OGG-формата живёт выше в этом же файле и не
// зависит от сети — вызывающий код решает, как реагировать на
// `selectBestFormat(...) === { kind: "drm" }` (R6.7).

import { SpotifyError } from "./spotify-errors";
import {
  getSpotifyClientToken,
  getSpotifySpclientHost,
  invalidateSpotifyToken,
} from "./spotify-token-capture";
import { trackIdToGid } from "./spotify-track-id";

/** Тайм-аут metadata-запроса (R21.2). */
const METADATA_TIMEOUT_MS = 5000;

/**
 * Маппинг численного `format`-поля во внутреннем metadata-ответе Spotify
 * на строковые литералы.
 *
 * Внутренний эндпоинт Spotify исторически отдавал `format` как enum-номер,
 * но Web-Player metadata в новых версиях иногда отдаёт строку. Делаем
 * defensive parsing: число → литерал из этой таблицы, строка → используется
 * как есть. Неизвестные численные значения превращаются в `UNKNOWN_${n}`,
 * чтобы `selectBestFormat` корректно проводил их в ветку `{ kind: "drm" }`
 * (Requirement 6.6, 20.6 — никогда не возвращать MP4/неизвестный формат
 * как ogg).
 */
export const FORMAT_ENUM_MAP: Readonly<Record<number, string>> = {
  0: "OGG_VORBIS_96",
  1: "OGG_VORBIS_160",
  2: "OGG_VORBIS_320",
  3: "MP3_256",
  4: "MP3_320",
  5: "MP3_160",
  6: "MP3_96",
  7: "MP3_160_ENC",
  8: "MP4_128",
  9: "MP4_256",
  10: "MP4_128_DUAL",
  11: "MP4_256_DUAL",
  12: "MP4_128_CBCS",
  13: "MP4_256_CBCS",
  14: "FLAC_FLAC",
  15: "AAC_24_NORM",
  16: "FLAC_FLAC_24BIT",
  17: "AAC_64",
  18: "AAC_24_ALC",
};

/**
 * Минимальный shape одного `audio_file`-объекта во внутреннем metadata-ответе.
 *
 * Реальный JSON содержит больше полей (например, `bitrate`, `compression`),
 * но для пайплайна нам нужны только `file_id` и `format`. Используем
 * `unknown` на стороне типа JSON, а в извлечении проверяем форму вручную.
 */
interface RawAudioFile {
  file_id?: unknown;
  format?: unknown;
}

/**
 * Нормализует raw-`format` (число или строка) в строковую метку формата,
 * пригодную к сравнению в `selectBestFormat`. Возвращает `null`, если
 * значение нельзя трактовать ни как известный enum, ни как строку.
 */
function normalizeFormat(raw: unknown): string | null {
  if (typeof raw === "string") {
    // Строковое представление — проводим как есть; selectBestFormat
    // отфильтрует неподдерживаемые литералы автоматически.
    return raw;
  }
  if (typeof raw === "number" && Number.isInteger(raw)) {
    const known = FORMAT_ENUM_MAP[raw];
    if (typeof known === "string") return known;
    // Неизвестный numeric enum — превращаем в брендированный литерал,
    // который заведомо не входит в OGG_PRIORITY и пойдёт в drm-ветку.
    return `UNKNOWN_${raw}`;
  }
  return null;
}

/**
 * Извлекает `(format, fileId)`-пары из массива raw-`audio_files`.
 * Невалидные записи (без `file_id`-строки или с нечитаемым `format`)
 * пропускаются молча — пайплайн всё равно фильтрует через
 * `selectBestFormat`, поэтому шум в логах не нужен.
 */
function collectAudioFiles(
  raw: unknown,
  out: { format: string; fileId: string }[],
): void {
  if (!Array.isArray(raw)) return;
  for (const entry of raw as RawAudioFile[]) {
    if (entry === null || typeof entry !== "object") continue;
    const fileId = (entry as RawAudioFile).file_id;
    if (typeof fileId !== "string" || fileId.length === 0) continue;
    const format = normalizeFormat((entry as RawAudioFile).format);
    if (format === null) continue;
    out.push({ format, fileId });
  }
}

/**
 * Парсит metadata-ответ и собирает плоский список пар `(format, fileId)`.
 *
 * Источники, которые сканируются (R6.2):
 *   1. `data.audio_files` — основной список форматов.
 *   2. `data.alternatives[].audio_files` — региональные/каталожные альтернативы.
 *   3. Defensive fallback `data.audio` — на случай альтернативного именования
 *      поля во внутреннем metadata-ответе.
 */
function parseTrackFiles(data: unknown): { format: string; fileId: string }[] {
  const out: { format: string; fileId: string }[] = [];
  if (data === null || typeof data !== "object") return out;
  const obj = data as Record<string, unknown>;

  collectAudioFiles(obj.audio_files, out);
  collectAudioFiles(obj.audio, out);

  const alts = obj.alternatives;
  if (Array.isArray(alts)) {
    for (const alt of alts) {
      if (alt === null || typeof alt !== "object") continue;
      const altObj = alt as Record<string, unknown>;
      collectAudioFiles(altObj.audio_files, out);
      collectAudioFiles(altObj.audio, out);
    }
  }

  return out;
}

/**
 * Канонические метаданные трека из metadata/4/track-ответа.
 *
 * Spotify Web API (`api.spotify.com/v1/tracks/{id}`) часто отвечает 429
 * на токен Web-плеера, поэтому канонические поля мы достаём из того же
 * запроса `spclient.wg.spotify.com/metadata/4/track/{gid}`, который и
 * так делается ради `audio_files`. Это устраняет лишний RTT и проблему
 * с rate-limit'ом публичного API.
 */
export interface SpotifyCanonicalMeta {
  artist: string;
  title: string;
  albumTitle?: string;
  durationMs?: number;
}

export interface FetchTrackFilesResult {
  files: SpotifyFormatEntry[];
  canonical: SpotifyCanonicalMeta;
}

function readCanonicalMeta(data: unknown): SpotifyCanonicalMeta {
  const obj = (data ?? {}) as Record<string, unknown>;
  // title: поле `name` (стабильное во всех версиях metadata-ответа).
  const rawTitle = typeof obj.name === "string" ? obj.name : "";

  // artists: массив объектов `{ name }`. Игнорируем элементы без
  // строкового name; склеиваем через запятую.
  const artistArr = Array.isArray(obj.artist)
    ? (obj.artist as ReadonlyArray<unknown>)
    : Array.isArray(obj.artists)
      ? (obj.artists as ReadonlyArray<unknown>)
      : [];
  const artistNames: string[] = [];
  for (const a of artistArr) {
    if (a !== null && typeof a === "object" && "name" in a) {
      const name = (a as { name?: unknown }).name;
      if (typeof name === "string" && name.length > 0) {
        artistNames.push(name);
      }
    }
  }
  const artist = artistNames.length > 0 ? artistNames.join(", ") : "";

  // album.name: опционально.
  let albumTitle: string | undefined;
  const album = obj.album;
  if (album !== null && typeof album === "object" && "name" in album) {
    const albumName = (album as { name?: unknown }).name;
    if (typeof albumName === "string" && albumName.length > 0) {
      albumTitle = albumName;
    }
  }

  // duration: поле `duration` в miliseconds (внутренний metadata).
  let durationMs: number | undefined;
  if (typeof obj.duration === "number" && obj.duration > 0) {
    durationMs = obj.duration;
  } else if (typeof obj.duration_ms === "number" && obj.duration_ms > 0) {
    durationMs = obj.duration_ms;
  }

  return {
    artist,
    title: rawTitle,
    ...(albumTitle !== undefined ? { albumTitle } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/**
 * Запрашивает у внутреннего metadata-эндпоинта Spotify список аудиофайлов
 * И канонические метаданные трека за один запрос (см. дизайн —
 * объединение шагов R5 и R6).
 */
export async function fetchTrackFiles(
  trackId: string,
  token: string,
  externalSignal?: AbortSignal,
): Promise<FetchTrackFilesResult> {
  // trackIdToGid сам бросит SpotifyError("SPOTIFY_TRACK_ID_INVALID"),
  // если trackId не соответствует формату 22-base62 (R9.6, R3.7).
  const trackGid = trackIdToGid(trackId);
  // Используем региональный spclient-хост, перехваченный у Web-плеера,
  // а не generic `spclient.wg.spotify.com` — generic-алиас может отвечать
  // 404 на metadata, в то время как региональный (gew4-spclient и т. д.) —
  // 200. `market=from_token` подсказывает Spotify применить регион
  // пользовательского аккаунта.
  const host = getSpotifySpclientHost() ?? "spclient.wg.spotify.com";
  const url = `https://${host}/metadata/4/track/${trackGid}?market=from_token`;

  // Свой AbortController для тайм-аута; пробрасываем abort и внешнего
  // signal'а вызывающего (например, общий тайм-аут оркестратора). Не
  // используем AbortSignal.any, чтобы не зависеть от availability в Chrome
  // service worker'е до 116 версии — ручной combinator кросс-совместим.
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    METADATA_TIMEOUT_MS,
  );
  let externalAbortHandler: (() => void) | null = null;
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalAbortHandler = () => controller.abort();
      externalSignal.addEventListener("abort", externalAbortHandler, {
        once: true,
      });
    }
  }

  let response: Response;
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    // Spotify Web-плеер шлёт client-token на все запросы к spclient.wg.
    // Без него `metadata/4/track` отвечает 404 / 401. Подставляем, если
    // успели его перехватить (обычно — после первого XHR Web-плеера).
    const clientToken = getSpotifyClientToken();
    if (clientToken !== null) {
      headers["client-token"] = clientToken;
    }
    response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (e: unknown) {
    // AbortError по таймауту/внешнему сигналу либо сетевая ошибка.
    // В обоих случаях мапим на SPOTIFY_METADATA_FAILED — внешний
    // оркестратор при необходимости перепарсит причину по signal.aborted.
    const reason =
      e instanceof Error && e.name === "AbortError"
        ? "Превышено время ожидания metadata Spotify"
        : `Сетевая ошибка metadata Spotify: ${String(e)}`;
    throw new SpotifyError("SPOTIFY_METADATA_FAILED", reason);
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal !== undefined && externalAbortHandler !== null) {
      externalSignal.removeEventListener("abort", externalAbortHandler);
    }
  }

  // Маппинг ошибок (R6.8, R6.9, R4.5):
  //   401/403 — токен протух → инвалидация + SPOTIFY_TOKEN_EXPIRED.
  //   прочее не-2xx — SPOTIFY_METADATA_FAILED с HTTP-статусом.
  if (response.status === 401 || response.status === 403) {
    invalidateSpotifyToken();
    throw new SpotifyError(
      "SPOTIFY_TOKEN_EXPIRED",
      "Сессия Spotify истекла, обновите страницу open.spotify.com",
    );
  }
  if (!response.ok) {
    // Дампим response-headers + первые 300 байт body, чтобы при 404/451 etc
    // было видно, что именно ответил сервер (rate-limit, missing client-token,
    // регион-блокировка). Это спасает кучу раундов диагностики.
    let bodyPreview = "";
    try {
      const text = await response.text();
      bodyPreview = text.slice(0, 300);
    } catch {
      /* ignore */
    }
    const ct = response.headers.get("content-type") ?? "";
    console.warn(
      `[ymd][spotify][file-resolver] metadata HTTP ${response.status} url=${url} content-type=${ct} body="${bodyPreview}"`,
    );
    throw new SpotifyError(
      "SPOTIFY_METADATA_FAILED",
      `metadata HTTP ${response.status}`,
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (e: unknown) {
    throw new SpotifyError(
      "SPOTIFY_METADATA_FAILED",
      `Не удалось разобрать metadata-ответ Spotify: ${String(e)}`,
    );
  }

  return {
    files: parseTrackFiles(data) as SpotifyFormatEntry[],
    canonical: readCanonicalMeta(data),
  };
}
