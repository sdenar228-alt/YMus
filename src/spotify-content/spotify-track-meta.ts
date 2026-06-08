import type { SpotifyTrackMeta } from "../shared/spotify-types";

// Регулярное выражение формата Spotify trackId — ровно 22 base62-символа.
// Используется и при извлечении из DOM (R3.2, R3.7), и в качестве
// предиката-валидатора, переиспользуемого вызывающими модулями.
const SPOTIFY_TRACK_ID_RE = /^[A-Za-z0-9]{22}$/;

// Robust извлечение trackId из произвольной строки href (или uri).
// Покрывает варианты, которые Spotify Web Player реально использует
// в современном DOM:
//   /track/{id}                     — старая ссылка
//   /track/{id}?si=...              — со share-параметром
//   /album/{x}/track/{id}           — track-link в трек-листе альбома
//   /artist/{x}/track/{id}          — track-link в попсе артиста
//   spotify:track:{id}              — data-uri / data-context-uri
//   https://open.spotify.com/track/{id} — абсолютный URL
const TRACK_ID_REGEX = /\/track\/([A-Za-z0-9]{22})(?:[/?#]|$)/;
const TRACK_URI_REGEX = /spotify:track:([A-Za-z0-9]{22})(?:[?#]|$)/;

const FALLBACK_ARTIST = "Unknown Artist";

/**
 * Проверяет, что строка соответствует формату Spotify trackId
 * (22 символа base62: `[A-Za-z0-9]{22}`).
 */
export function isValidSpotifyTrackId(value: string): boolean {
  return SPOTIFY_TRACK_ID_RE.test(value);
}

/**
 * Извлекает trackId из произвольной строки (href, uri, текст) по двум
 * шаблонам: путь `/track/{id}` и uri `spotify:track:{id}`.
 *
 * Возвращает `null`, если ни один шаблон не совпал. Экспортируется,
 * чтобы now-playing-injector мог переиспользовать ту же логику для
 * различных источников DOM-ссылок.
 */
export function extractTrackIdFromString(value: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const m1 = value.match(TRACK_ID_REGEX);
  if (m1 !== null) return m1[1];
  const m2 = value.match(TRACK_URI_REGEX);
  if (m2 !== null) return m2[1];
  return null;
}

/**
 * Сканирует поддерево `root` и возвращает первый найденный валидный
 * Spotify-trackId. Источники (в порядке приоритета):
 *   1. `<a href="...">` с подстрокой `/track/{22-base62}` (любой
 *      формат: `/track/...`, `/album/x/track/...`, абсолютный URL).
 *   2. Атрибуты `data-context-uri`/`data-uri` со значением
 *      `spotify:track:{22-base62}`.
 *
 * Экспортируется отдельно, чтобы now-playing-injector мог искать id
 * в нестандартных местах bar'а (current Spotify DOM ставит туда только
 * ссылку на альбом — `/album/{id}` — а не на трек).
 */
export function findSpotifyTrackIdInSubtree(root: Element): string | null {
  // 1. Любая ссылка с /track/{id} в href.
  const anchors = root.querySelectorAll<HTMLAnchorElement>('a[href*="/track/"]');
  for (const link of Array.from(anchors)) {
    const href = link.getAttribute("href");
    if (href === null) continue;
    const id = extractTrackIdFromString(href);
    if (id !== null) return id;
  }

  // 2. data-uri / data-context-uri = spotify:track:{id}
  const uriHosts = root.querySelectorAll<HTMLElement>(
    "[data-context-uri], [data-uri]",
  );
  for (const el of Array.from(uriHosts)) {
    const uri =
      el.getAttribute("data-context-uri") ?? el.getAttribute("data-uri") ?? "";
    const id = extractTrackIdFromString(uri);
    if (id !== null) return id;
  }

  return null;
}

/**
 * Извлечь метаданные трека Spotify из DOM-узла строки трек-листа
 * (`Spotify_Track_Row`) либо из now-playing bar.
 *
 * Возвращает `null`, если в поддереве не нашлось ни одного валидного
 * trackId (R3.2, R3.7). Заполненные поля `artist`/`title` попадают
 * в результат, недостающие — fallback (`"Unknown Artist"`,
 * `spotify_track_{trackId}`).
 */
export function extractSpotifyTrackMeta(row: Element): SpotifyTrackMeta | null {
  try {
    const trackId = findSpotifyTrackIdInSubtree(row);
    if (trackId === null) return null;

    const title = readTitle(row, trackId);
    const artist = readArtists(row);
    const albumTitle = readAlbumTitle(row);
    const durationMs = readDurationMs(row);

    const meta: SpotifyTrackMeta = {
      trackId,
      trackUri: `spotify:track:${trackId}`,
      artist,
      title,
    };
    if (albumTitle !== undefined) meta.albumTitle = albumTitle;
    if (durationMs !== undefined) meta.durationMs = durationMs;
    return meta;
  } catch {
    return null;
  }
}

/**
 * Извлекает текст названия трека. Источники в порядке приоритета:
 *   1. Ссылка с конкретным `/track/{id}` в href — чаще всего внутри
 *      `<a data-testid="internal-track-link">` или просто `<a>` с
 *      title-текстом.
 *   2. Любая ссылка `[data-testid="context-link"]` (now-playing bar).
 *   3. Любой `[data-testid="tracklist-row-title"]` (старый Spotify).
 *   4. Fallback — `spotify_track_{trackId}`.
 *
 * `trim()` срезает пробелы; вложенные пробелы внутри названия
 * сохраняются, чтобы санитайзер имени файла видел исходную форму.
 */
function readTitle(row: Element, trackId: string): string {
  // 1. Anchor, чей href содержит ровно этот trackId.
  const anchors = row.querySelectorAll<HTMLAnchorElement>('a[href*="/track/"]');
  for (const link of Array.from(anchors)) {
    const href = link.getAttribute("href") ?? "";
    if (href.includes(`/track/${trackId}`)) {
      const text = link.textContent?.trim() ?? "";
      if (text.length > 0) return text;
    }
  }
  // 2. Now-playing widget: `data-testid="context-link"`.
  const contextLink = row.querySelector<HTMLElement>(
    '[data-testid="context-link"]',
  );
  if (contextLink !== null) {
    const text = contextLink.textContent?.trim() ?? "";
    if (text.length > 0) return text;
  }
  // 3. Старый разметочный testid.
  const oldTitle = row.querySelector<HTMLElement>(
    '[data-testid="tracklist-row-title"]',
  );
  if (oldTitle !== null) {
    const text = oldTitle.textContent?.trim() ?? "";
    if (text.length > 0) return text;
  }
  return `spotify_track_${trackId}`;
}

/**
 * Читает имена исполнителей из всех ссылок-исполнителей внутри `row`
 * и склеивает их через `", "`. При отсутствии валидных имён возвращает
 * fallback `"Unknown Artist"` (R3.3, R3.6).
 */
function readArtists(row: Element): string {
  const links = row.querySelectorAll<HTMLAnchorElement>('a[href*="/artist/"]');
  const names: string[] = [];
  for (const link of Array.from(links)) {
    const text = link.textContent?.trim() ?? "";
    if (text.length > 0 && !names.includes(text)) names.push(text);
  }
  if (names.length === 0) return FALLBACK_ARTIST;
  return names.join(", ");
}

/**
 * Извлекает название альбома из первой ссылки `<a href*="/album/">`.
 */
function readAlbumTitle(row: Element): string | undefined {
  const link = row.querySelector<HTMLAnchorElement>('a[href*="/album/"]');
  if (link === null) return undefined;
  const text = link.textContent?.trim() ?? "";
  return text.length > 0 ? text : undefined;
}

/**
 * Пытается распарсить длительность трека из последней ячейки в формате
 * `m:ss`/`mm:ss`. Возвращает миллисекунды или `undefined`.
 */
function readDurationMs(row: Element): number | undefined {
  const candidates = Array.from(row.querySelectorAll<HTMLElement>("div, span"));
  for (let i = candidates.length - 1; i >= 0; i--) {
    const text = candidates[i].textContent?.trim() ?? "";
    const match = text.match(/^(\d{1,2}):([0-5]\d)$/);
    if (match !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      return (minutes * 60 + seconds) * 1000;
    }
  }
  return undefined;
}
