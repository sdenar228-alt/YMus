// Feature: yandex-music-downloader
// Извлечение метаданных текущего играющего трека.

import type { TrackMeta } from "../shared/types";
import { getLastBridgeTrack } from "./ym-bridge-listener";

const UNKNOWN = "Unknown";

/**
 * Фрагменты, по которым распознаётся "Page Title Literal" — статический
 * заголовок главной страницы Я.Музыки, который не обновляется при смене
 * трека в режиме «Моя Волна». Сравнение идёт по lowercased substring.
 *
 * Используется в task 3.2 для фильтрации мусорного og:title и в
 * `readFromPlayerBarDOM()` ниже — чтобы не подтягивать этот текст из DOM,
 * если он случайно туда попадёт.
 */
const PAGE_TITLE_LITERAL_FRAGMENTS = [
  "собираем музыку",
  "music for you",
] as const;

/**
 * Wave-mode predicate. Возвращает true, если URL парсится как стандартный URL
 * и содержит query-параметр `wave` (например, `?wave=onyourwave`).
 *
 * Любая ошибка парсинга URL → false (consumer treats wave-mode as off when
 * the URL is malformed; preserves non-wave behavior).
 */
function isWaveMode(url: string = location.href): boolean {
  try {
    const u = new URL(url);
    return u.searchParams.has("wave");
  } catch {
    return false;
  }
}

/**
 * Проверяет, является ли произвольная строка "Page Title Literal" — то есть
 * содержит ли она один из известных фрагментов главной страницы Я.Музыки
 * (case-insensitive).
 */
function isPageTitleLiteral(text: string): boolean {
  const lower = text.toLowerCase();
  return PAGE_TITLE_LITERAL_FRAGMENTS.some((f) => lower.includes(f));
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseArtistTitleText(text: string): Pick<TrackMeta, "artist" | "title"> | null {
  const normalized = normalizeVisibleText(text);
  if (normalized.length === 0 || normalized.length > 180) return null;
  if (isPageTitleLiteral(normalized)) return null;

  const parts = normalized.split(/\s+[—–-]\s+/);
  if (parts.length < 2) return null;

  const artist = parts[0].trim();
  const title = parts.slice(1).join(" — ").trim();
  if (artist.length === 0 || title.length === 0) return null;
  if (isPageTitleLiteral(artist) || isPageTitleLiteral(title)) return null;

  return { artist, title };
}

function findArtistTitleInPlayerText(root: Element): Pick<TrackMeta, "artist" | "title"> | null {
  const candidates: string[] = [];
  const nodes = [root, ...Array.from(root.querySelectorAll("*"))];

  for (const node of nodes) {
    const text = normalizeVisibleText(node.textContent ?? "");
    if (text.length === 0) continue;
    if (!/[—–-]/.test(text)) continue;
    candidates.push(text);
  }

  candidates.sort((a, b) => a.length - b.length);
  for (const text of candidates) {
    const parsed = parseArtistTitleText(text);
    if (parsed !== null) return parsed;
  }

  return null;
}

/**
 * Источник 5 (новый): чтение текущего трека из DOM плеер-бара.
 *
 * Используется как fallback, когда `externalAPI` недоступен и URL/og:title
 * не содержат полезных данных (типичный случай — режим «Моя Волна»).
 *
 * Селекторы плеер-бара совпадают с используемыми в `player-observer.ts`
 * и `floating-button.ts`. Из ссылки `a[href*="/track/"]` извлекается
 * `trackId` (поддерживаются оба формата: `/album/{a}/track/{t}` →
 * `<track>:<album>` и одиночный `/track/{t}` → `<track>`). Текст этой же
 * ссылки используется как `title` (если он не Page Title Literal).
 * Имена артистов берутся из `a[href*="/artist/"]` и склеиваются через
 * `, ` — так же, как `externalAPI` склеивает `track.artists[].name`.
 */
type UnknownRecord = Record<string, unknown>;

function normalizeComparableText(text: string | undefined): string {
  return normalizeVisibleText(text ?? "").toLowerCase();
}

function textsMatch(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeComparableText(a);
  const right = normalizeComparableText(b);
  return left.length > 0 && right.length > 0 && left === right;
}

function readId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^\d+(?::\d+)?$/.test(trimmed) ? trimmed : undefined;
}

function readObjectId(obj: unknown): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  return readId((obj as UnknownRecord).id);
}

function readTrackArtist(obj: UnknownRecord): string | undefined {
  if (typeof obj.artist === "string" && obj.artist.trim().length > 0) {
    return obj.artist;
  }

  if (!Array.isArray(obj.artists)) return undefined;
  const names = obj.artists
    .map((artist) => {
      if (typeof artist === "string") return artist;
      if (artist && typeof artist === "object") {
        const name = (artist as UnknownRecord).name;
        return typeof name === "string" ? name : "";
      }
      return "";
    })
    .filter((name) => name.trim().length > 0);

  return names.length > 0 ? names.join(", ") : undefined;
}

function readTrackIdFromObject(obj: UnknownRecord): string | undefined {
  const id = readId(obj.realId) ?? readId(obj.id) ?? readId(obj.trackId);
  if (id === undefined) return undefined;
  if (id.includes(":")) return id;

  const albumId =
    readId(obj.albumId) ??
    readObjectId(obj.album) ??
    (Array.isArray(obj.albums) && obj.albums.length > 0
      ? readObjectId(obj.albums[0])
      : undefined);

  return albumId !== undefined ? `${id}:${albumId}` : id;
}

function objectMatchesVisibleTrack(
  obj: UnknownRecord,
  visible: Partial<Pick<TrackMeta, "artist" | "title">>,
): boolean {
  const title = typeof obj.title === "string" ? obj.title : undefined;
  const artist = readTrackArtist(obj);

  if (visible.title !== undefined && title !== undefined) {
    if (!textsMatch(visible.title, title)) return false;
    if (visible.artist !== undefined && artist !== undefined) {
      return textsMatch(visible.artist, artist);
    }
    return true;
  }

  return (
    visible.artist !== undefined &&
    artist !== undefined &&
    textsMatch(visible.artist, artist)
  );
}

function findMatchingTrackIdInValue(
  value: unknown,
  visible: Partial<Pick<TrackMeta, "artist" | "title">>,
  seen: WeakSet<object>,
  budget: { remaining: number },
  depth = 0,
): string | undefined {
  if (budget.remaining <= 0 || depth > 7) return undefined;
  if (!value || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  budget.remaining -= 1;

  const obj = value as UnknownRecord;
  if (objectMatchesVisibleTrack(obj, visible)) {
    const id = readTrackIdFromObject(obj);
    if (id !== undefined) return id;
  }

  for (const key of [
    "track",
    "currentTrack",
    "playingTrack",
    "nowPlaying",
    "entity",
    "item",
    "data",
    "state",
    "value",
    "props",
  ]) {
    if (!(key in obj)) continue;
    const id = findMatchingTrackIdInValue(obj[key], visible, seen, budget, depth + 1);
    if (id !== undefined) return id;
  }

  for (const nested of Object.values(obj)) {
    const id = findMatchingTrackIdInValue(nested, visible, seen, budget, depth + 1);
    if (id !== undefined) return id;
  }

  return undefined;
}

function findTrackIdInReactInternals(
  element: Element,
  visible: Partial<Pick<TrackMeta, "artist" | "title">>,
): string | undefined {
  const host = element as unknown as UnknownRecord;

  for (const key of Object.keys(host)) {
    if (key.startsWith("__reactProps$")) {
      const id = findMatchingTrackIdInValue(
        host[key],
        visible,
        new WeakSet<object>(),
        { remaining: 250 },
      );
      if (id !== undefined) return id;
    }

    if (!key.startsWith("__reactFiber$")) continue;
    let fiber = host[key] as UnknownRecord | null | undefined;
    for (let depth = 0; fiber && depth < 30; depth += 1) {
      for (const field of ["memoizedProps", "pendingProps", "memoizedState"]) {
        const id = findMatchingTrackIdInValue(
          fiber[field],
          visible,
          new WeakSet<object>(),
          { remaining: 250 },
        );
        if (id !== undefined) return id;
      }
      const parent = fiber.return;
      fiber = parent && typeof parent === "object" ? (parent as UnknownRecord) : null;
    }
  }

  return undefined;
}

function findReactTrackIdNearVisibleText(
  root: Element,
  visible: Partial<Pick<TrackMeta, "artist" | "title">>,
): string | undefined {
  if (visible.title === undefined && visible.artist === undefined) return undefined;

  const title = normalizeComparableText(visible.title);
  const artist = normalizeComparableText(visible.artist);
  const candidates = [root, ...Array.from(root.querySelectorAll("*"))]
    .filter((node) => {
      const text = normalizeComparableText(node.textContent ?? "");
      if (text.length === 0) return false;
      return (
        (title.length > 0 && text.includes(title)) ||
        (artist.length > 0 && text.includes(artist))
      );
    })
    .sort(
      (a, b) =>
        normalizeVisibleText(a.textContent ?? "").length -
        normalizeVisibleText(b.textContent ?? "").length,
    );

  for (const node of candidates) {
    const id = findTrackIdInReactInternals(node, visible);
    if (id !== undefined) return id;
  }

  return undefined;
}

function bridgeMatchesVisibleMeta(
  bridge: { artist?: string; title?: string } | null,
  visible: Partial<Pick<TrackMeta, "artist" | "title">>,
): boolean {
  if (bridge === null) return false;

  const titleComparable = visible.title !== undefined && bridge.title !== undefined;
  const artistComparable = visible.artist !== undefined && bridge.artist !== undefined;

  if (titleComparable && !textsMatch(visible.title, bridge.title)) return false;
  if (artistComparable && !textsMatch(visible.artist, bridge.artist)) return false;

  return titleComparable || artistComparable;
}

function findPlayerRoot(): Element | null {
  const selectors = [
    '[class*="PlayerBar"]',
    '[class*="PlayerBarDesktop"]',
    '[class*="PlayerBar_root"]',
    '[class*="player-bar"]',
    '[class*="PlayerSide"]',
    '[class*="SidePlayer"]',
    '[class*="FullscreenPlayer"]',
    '[class*="Wave_player"]',
    '[data-test-id*="player"]',
    '[data-test-id*="Player"]',
  ].join(", ");

  const candidates = Array.from(document.querySelectorAll(selectors));
  for (const candidate of candidates) {
    if (candidate.querySelector('a[href*="/track/"]') !== null) {
      return candidate;
    }
    if (findArtistTitleInPlayerText(candidate) !== null) {
      return candidate;
    }
  }

  return null;
}

function readFromPlayerBarDOM(): Partial<TrackMeta> {
  const result: Partial<TrackMeta> = {};
  try {
    // The 2026 Yandex Music redesign moved the player from the bottom bar
    // to a side panel on the home page (visible in "Моя волна"). The
    // classic `[class*="PlayerBar..."]` containers no longer exist there,
    // so we widen the search:
    //   1. Try the classic player containers first (still used elsewhere).
    //   2. If nothing matches, fall through to a global `/track/` link
    //      lookup — the new side panel still has at least one such link.
    const root = findPlayerRoot();

    // Search scope: prefer the matched player container, otherwise fall
    // back to the entire document so the new side-panel layout still works.
    const scope: ParentNode = root ?? document;

    const trackLink = scope.querySelector(
      'a[href*="/track/"]',
    ) as HTMLAnchorElement | null;
    if (trackLink !== null) {
      const href = trackLink.getAttribute("href") ?? "";
      const albumTrack = href.match(/\/album\/(\d+)\/track\/(\d+)/);
      if (albumTrack !== null) {
        result.trackId = `${albumTrack[2]}:${albumTrack[1]}`;
      } else {
        const trackOnly = href.match(/\/track\/(\d+)/);
        if (trackOnly !== null) result.trackId = trackOnly[1];
      }
      const titleText = trackLink.textContent?.trim();
      if (
        titleText !== undefined &&
        titleText.length > 0 &&
        !isPageTitleLiteral(titleText)
      ) {
        result.title = titleText;
      }
    }

    const artistLinks = scope.querySelectorAll('a[href*="/artist/"]');
    if (artistLinks.length > 0) {
      const names = Array.from(artistLinks)
        .map((el) => el.textContent?.trim() ?? "")
        .filter((n) => n.length > 0 && !isPageTitleLiteral(n));
      if (names.length > 0) result.artist = names.join(", ");
    }

    if ((result.artist === undefined || result.title === undefined) && root !== null) {
      const parsedText = findArtistTitleInPlayerText(root);
      if (parsedText !== null) {
        if (result.artist === undefined) result.artist = parsedText.artist;
        if (result.title === undefined) result.title = parsedText.title;
      }
    }

    if (result.trackId === undefined && root !== null) {
      const reactTrackId = findReactTrackIdNearVisibleText(root, {
        artist: result.artist,
        title: result.title,
      });
      if (reactTrackId !== undefined) result.trackId = reactTrackId;
    }
  } catch {
    // ignore — на любых неожиданных ошибках возвращаем то, что успели собрать.
  }
  return result;
}

interface YandexExternalAPI {
  getCurrentTrack?: () => {
    id?: string | number;
    realId?: string | number;
    albumId?: string | number;
    title?: string;
    artists?: Array<{ name?: string }>;
    albums?: Array<{ id?: string | number }>;
  } | null;
}

/**
 * Источник 1: window.externalAPI — официальный публичный API Я.Музыки,
 * существует исторически и используется виджетами.
 */
function readFromExternalAPI(): TrackMeta | null {
  try {
    const api = (window as unknown as { externalAPI?: YandexExternalAPI })
      .externalAPI;
    if (api === undefined || typeof api.getCurrentTrack !== "function") {
      return null;
    }
    const track = api.getCurrentTrack();
    if (!track) return null;

    const trackId = track.realId ?? track.id;
    if (trackId === undefined || trackId === null) return null;

    const albumId =
      track.albumId ??
      (Array.isArray(track.albums) && track.albums.length > 0
        ? track.albums[0]?.id
        : undefined);

    const fullId =
      albumId !== undefined && albumId !== null
        ? `${trackId}:${albumId}`
        : String(trackId);

    const artists = (track.artists ?? [])
      .map((a) => a?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);

    return {
      trackId: fullId,
      artist: artists.length > 0 ? artists.join(", ") : UNKNOWN,
      title:
        typeof track.title === "string" && track.title.length > 0
          ? track.title
          : UNKNOWN,
    };
  } catch {
    return null;
  }
}

/**
 * Источник 2: <meta> теги OpenGraph, которые Я.Музыка обновляет
 * при смене трека (og:title содержит "Артист — Трек").
 */
function readFromMetaTags(): Partial<TrackMeta> {
  try {
    const ogTitle = document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content");
    if (ogTitle === null || ogTitle === undefined) return {};
    // task 3.2: на режиме «Моя Волна» og:title не обновляется и остаётся
    // равным Page Title Literal — отбрасываем его до любого парсинга, чтобы
    // не порождать мусорные artist/title из главного заголовка сайта.
    if (isPageTitleLiteral(ogTitle)) return {};

    // Формат: "Артист — Трек • Название альбома" (либо просто "Артист — Трек")
    const cleaned = ogTitle.split("•")[0].trim();
    const parts = cleaned.split(/\s+[—–-]\s+/);
    if (parts.length >= 2) {
      return {
        artist: parts[0].trim(),
        title: parts.slice(1).join(" — ").trim(),
      };
    }
    return { title: cleaned };
  } catch {
    return {};
  }
}

/**
 * Источник 3: data-атрибуты на DOM-элементах плеера.
 */
function readFromDOM(): Partial<TrackMeta> {
  const result: Partial<TrackMeta> = {};
  try {
    // Поиск ссылки на /track/ внутри плеера — самый надёжный способ.
    const candidates = [
      '[class*="PlayerBar"] a[href*="/track/"]',
      '[class*="PlayerBarDesktop"] a[href*="/track/"]',
      'footer a[href*="/track/"]',
      'a[href*="/album/"][href*="/track/"]',
    ];
    for (const selector of candidates) {
      const link = document.querySelector(selector);
      if (link === null) continue;
      const href = (link as HTMLAnchorElement).getAttribute("href") ?? "";
      const m = href.match(/\/album\/(\d+)\/track\/(\d+)/);
      if (m !== null) {
        result.trackId = `${m[2]}:${m[1]}`;
        break;
      }
      const m2 = href.match(/\/track\/(\d+)/);
      if (m2 !== null) {
        result.trackId = m2[1];
        break;
      }
    }
  } catch {
    // ignore
  }
  return result;
}

/**
 * Источник 4: URL текущей страницы.
 */
function readFromURL(): Partial<TrackMeta> {
  try {
    const albumTrack = location.pathname.match(/\/album\/(\d+)\/track\/(\d+)/);
    if (albumTrack !== null) {
      return { trackId: `${albumTrack[2]}:${albumTrack[1]}` };
    }
    const trackOnly = location.pathname.match(/\/track\/(\d+)/);
    if (trackOnly !== null) {
      return { trackId: trackOnly[1] };
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Возвращает метаданные текущего трека или null если не удалось определить.
 *
 * Приоритет источников:
 *   1. externalAPI (самый надёжный — реальный плеер; early return сохраняет
 *      побайтовое поведение для не-волновых страниц).
 *   2. fallback chain (используется когда externalAPI недоступен):
 *      - readFromPlayerBarDOM() — чтение текущего трека напрямую из DOM плеер-бара
 *        (важно для режима «Моя Волна», где URL не содержит /track/ и og:title
 *        статичен).
 *      - readFromMetaTags() — og:title (отфильтрован от Page Title Literal).
 *      - readFromDOM() — поиск /track/{n} ссылок в плеер-баре (legacy-источник
 *        trackId).
 *      - readFromURL() — pathname текущей страницы; на волне игнорируется,
 *        потому что URL формы `/?wave=...` не содержит `/track/`.
 */
export function extractTrackMeta(): TrackMeta | null {
  const fromAPI = readFromExternalAPI();
  if (fromAPI !== null) return fromAPI;

  // Source 0 (highest priority after externalAPI): the page-bridge
  // network sniffer. On the 2026 redesign of "Моя волна" this is the
  // ONLY reliable source — DOM, og:title and externalAPI are all empty.
  const fromBridge = getLastBridgeTrack();

  const fromPlayerBar = readFromPlayerBarDOM();
  const fromMeta = readFromMetaTags();
  const fromDOM = readFromDOM();
  const fromURL = readFromURL();

  const bridgeHasMatchingVisibleText = bridgeMatchesVisibleMeta(
    fromBridge,
    fromPlayerBar,
  );
  const playerHasVisibleMeta =
    fromPlayerBar.title !== undefined || fromPlayerBar.artist !== undefined;
  const bridgeUsable =
    fromBridge !== null &&
    (!isWaveMode() || (playerHasVisibleMeta && bridgeHasMatchingVisibleText));

  const bridgeTrackId =
    bridgeUsable && fromBridge?.trackId !== undefined && fromBridge.trackId.length > 0
      ? fromBridge.albumId !== undefined && fromBridge.albumId.length > 0
        ? `${fromBridge.trackId}:${fromBridge.albumId}`
        : fromBridge.trackId
      : undefined;

  // The page bridge observes network traffic. In "Моя волна" Yandex Music
  // can prefetch the next track, so a fresh bridge value may be next-up rather
  // than now-playing. Prefer the visible player bar when it has a track link;
  // keep the bridge as the fallback for redesigns where the DOM is empty.
  const trackId =
    fromPlayerBar.trackId ??
    bridgeTrackId ??
    fromDOM.trackId ??
    (isWaveMode() ? undefined : fromURL.trackId);

  if (trackId === undefined || trackId.length === 0) {
    console.warn("[ymd][track-meta] failed to resolve trackId", {
      url: location.href,
      isWaveMode: isWaveMode(),
      hasExternalAPI:
        (window as unknown as { externalAPI?: unknown }).externalAPI !==
        undefined,
      fromBridge,
      fromPlayerBar,
      fromMeta,
      fromDOM,
      fromURL,
    });
    return null;
  }

  const bridgeMatchesSelected =
    bridgeTrackId !== undefined &&
    (bridgeTrackId === trackId || bridgeTrackId.split(":")[0] === trackId.split(":")[0]);
  const selectedFromBridge = bridgeTrackId !== undefined && bridgeTrackId === trackId;

  const artist =
    selectedFromBridge
      ? fromBridge?.artist ?? fromPlayerBar.artist ?? fromMeta.artist ?? UNKNOWN
      : fromPlayerBar.artist ??
        (bridgeMatchesSelected ? fromBridge?.artist : undefined) ??
        fromMeta.artist ??
        UNKNOWN;
  const title =
    selectedFromBridge
      ? fromBridge?.title ?? fromPlayerBar.title ?? fromMeta.title ?? UNKNOWN
      : fromPlayerBar.title ??
        (bridgeMatchesSelected ? fromBridge?.title : undefined) ??
        fromMeta.title ??
        UNKNOWN;

  if (isWaveMode()) {
    console.info("[ymd][track-meta][wave] selected", {
      trackId,
      artist,
      title,
      source:
        fromPlayerBar.trackId !== undefined
          ? "player-bar-link"
          : selectedFromBridge
            ? fromBridge?.detectionSource ?? "bridge"
            : "fallback",
      bridge: fromBridge,
      playerBar: fromPlayerBar,
    });
  }

  return { trackId, artist, title };
}
