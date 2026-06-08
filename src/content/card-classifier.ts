/**
 * Card classifier — classifies href links from Cover_Card and Carousel_Card
 * into categories to determine whether a download button should be injected.
 *
 * Requirements: 4.1–4.10
 */

export type CardCategory =
  | "album"
  | "playlist-classic"
  | "playlist-uuid"
  | "artist"
  | "podcast"
  | "mix"
  | "user-profile"
  | "unknown";

export type CardIdentifier =
  | { kind: "album"; albumId: string }
  | { kind: "playlist-classic"; owner: string; playlistId: string }
  | { kind: "playlist-uuid"; uuid: string }
  | null;

export interface CardClassification {
  readonly category: CardCategory;
  readonly identifier: CardIdentifier;
}

/** Categories eligible for download button injection (Req 4.9). */
export const DOWNLOADABLE_CATEGORIES: ReadonlySet<CardCategory> = new Set<CardCategory>([
  "album",
  "playlist-classic",
  "playlist-uuid",
]);

/** Podcast-related block titles used for disambiguation (Req 4.6). */
const PODCAST_BLOCK_TITLES: ReadonlySet<string> = new Set([
  "подкасты",
  "podcasts",
]);

// --- Regex patterns (ordered per match table) ---

/** Track page — /album/{n}/track/{n} → unknown (not a card, it's a track page) */
const RE_TRACK = /^\/album\/\d+\/track\/\d+\/?$/;

/** Album — /album/{n} */
const RE_ALBUM = /^\/album\/(\d+)\/?$/;

/** Podcast section — /podcasts/... or /podcast/... */
const RE_PODCASTS_URL = /^\/podcasts?(\/.*)?$/;

/** Playlist classic — /users/{owner}/playlists/{n} */
const RE_PLAYLIST_CLASSIC = /^\/users\/([^/]+)\/playlists\/(\d+)\/?$/;

/** Playlist UUID — /playlists/(lk.)?{uuid with 8+ hex/dash chars} */
const RE_PLAYLIST_UUID = /^\/playlists\/((?:lk\.)?[0-9a-f-]{8,})\/?$/i;

/** Artist — /artist/{n} */
const RE_ARTIST = /^\/artist\/\d+\/?$/;

/** Mix — /genre/..., /mood/..., /dailyPlaylist... */
const RE_MIX = /^\/(genre|mood|dailyPlaylist)(\/.*)?$/;

/** User profile — /users/{owner} without /playlists/ */
const RE_USER_PROFILE = /^\/users\/[^/]+\/?$/;

/** Check if href contains /podcasts/ or /podcast/ segment (for disambiguation). */
const RE_PODCAST_SEGMENT = /\/podcasts?\//;

/**
 * Extracts the pathname from an href string (handles both relative and absolute URLs).
 */
function extractPathname(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    try {
      return new URL(href).pathname;
    } catch {
      return href;
    }
  }
  // Strip query string and hash for matching
  const qIdx = href.indexOf("?");
  const hIdx = href.indexOf("#");
  let end = href.length;
  if (qIdx !== -1) end = Math.min(end, qIdx);
  if (hIdx !== -1) end = Math.min(end, hIdx);
  return href.slice(0, end);
}

/**
 * Classifies the href of a card according to the ordered match table.
 *
 * Order: track → album → podcast → playlist-classic → playlist-uuid → artist → mix → user-profile → unknown
 *
 * @param href — relative or absolute URL of the card link
 * @param parentBlockTitle — title of the nearest Carousel_Block (optional, for podcast disambiguation)
 */
export function classifyCardHref(
  href: string,
  parentBlockTitle?: string | null,
): CardClassification {
  const pathname = extractPathname(href);
  const blockTitleLower = parentBlockTitle?.toLowerCase()?.trim() ?? null;
  const blockIsPodcast = blockTitleLower !== null && PODCAST_BLOCK_TITLES.has(blockTitleLower);

  // 1. Track page → unknown
  if (RE_TRACK.test(pathname)) {
    return { category: "unknown", identifier: null };
  }

  // 2. Album
  const albumMatch = pathname.match(RE_ALBUM);
  if (albumMatch) {
    // Podcast disambiguation (Req 4.6):
    // If BOTH signals present (block title is podcast AND href contains /podcasts/ or /podcast/) → podcast
    // If only block title says podcast but href does NOT contain /podcasts?/ → classify as album (by URL rule)
    // If only URL contains /podcasts?/ but block title is not podcast → check href for /podcasts?/ segment
    const hrefHasPodcastSegment = RE_PODCAST_SEGMENT.test(pathname);

    if (blockIsPodcast && hrefHasPodcastSegment) {
      return { category: "podcast", identifier: null };
    }
    if (blockIsPodcast && !hrefHasPodcastSegment) {
      // Only one signal (block title) but href doesn't contain /podcasts?/ → classify by URL (album)
      return { category: "album", identifier: { kind: "album", albumId: albumMatch[1] } };
    }
    // No podcast signal → album
    return { category: "album", identifier: { kind: "album", albumId: albumMatch[1] } };
  }

  // 3. Podcast URL (/podcasts/... or /podcast/...)
  if (RE_PODCASTS_URL.test(pathname)) {
    return { category: "podcast", identifier: null };
  }

  // 4. Playlist classic — /users/{owner}/playlists/{n}
  const playlistClassicMatch = pathname.match(RE_PLAYLIST_CLASSIC);
  if (playlistClassicMatch) {
    return {
      category: "playlist-classic",
      identifier: {
        kind: "playlist-classic",
        owner: playlistClassicMatch[1],
        playlistId: playlistClassicMatch[2],
      },
    };
  }

  // 5. Playlist UUID — /playlists/(lk.)?{uuid}
  const playlistUuidMatch = pathname.match(RE_PLAYLIST_UUID);
  if (playlistUuidMatch) {
    return {
      category: "playlist-uuid",
      identifier: { kind: "playlist-uuid", uuid: playlistUuidMatch[1] },
    };
  }

  // 6. Artist — /artist/{n}
  if (RE_ARTIST.test(pathname)) {
    return { category: "artist", identifier: null };
  }

  // 7. Mix — /genre/, /mood/, /dailyPlaylist
  if (RE_MIX.test(pathname)) {
    return { category: "mix", identifier: null };
  }

  // 8. User profile — /users/{owner} (without /playlists/)
  if (RE_USER_PROFILE.test(pathname)) {
    return { category: "user-profile", identifier: null };
  }

  // 9. Unknown
  return { category: "unknown", identifier: null };
}

/**
 * Builds the absolute URL for a given downloadable identifier,
 * used as `payload.input` for RESOLVE_ALBUM / RESOLVE_PLAYLIST messages.
 *
 * Req 11.4: URL format matches what message-router.ts expects.
 */
export function buildAlbumIdentifierUrl(
  identifier: NonNullable<CardIdentifier>,
): string {
  switch (identifier.kind) {
    case "album":
      return `https://music.yandex.ru/album/${identifier.albumId}`;
    case "playlist-classic":
      return `https://music.yandex.ru/users/${identifier.owner}/playlists/${identifier.playlistId}`;
    case "playlist-uuid":
      return `https://music.yandex.ru/playlists/${identifier.uuid}`;
  }
}
