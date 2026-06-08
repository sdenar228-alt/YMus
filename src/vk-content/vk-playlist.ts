import type { VkTrackMeta } from "../shared/types";
import { extractVkTrackMeta } from "./vk-track-meta";
import { showVkError, VK_ERROR_CODES } from "./vk-error-toast";

const PLAYLIST_BTN_CLASS = "ymus-vk-playlist-btn";

/** Tracks the active MutationObserver so it can be disconnected on re-initialization */
let activeObserver: MutationObserver | null = null;

/** Selectors for audio rows inside a playlist container */
const AUDIO_ROW_SELECTORS = [
  '.audio_row[data-full-id]',
  '[class*="AudioRow__root"][data-sortable-id]',
  '[class*="AudioRow"][data-sortable-id]',
];

/**
 * Start observing DOM for VK playlist containers and inject "Скачать плейлист" button.
 */
export function startVkPlaylistInjector(
  onDownloadPlaylist: (
    tracks: VkTrackMeta[],
    playlistTitle: string,
    progressCallback: (downloaded: number, total: number) => void,
  ) => void,
): void {
  // Disconnect any previous observer to prevent stale callbacks
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }

  // Remove any existing playlist buttons (ensures fresh state on re-initialization)
  document.querySelectorAll(`.${PLAYLIST_BTN_CLASS}`).forEach((btn) => btn.remove());

  // Initial scan
  scanAndInject(onDownloadPlaylist);

  // Observe DOM mutations for dynamically loaded playlist containers
  activeObserver = new MutationObserver(() => {
    try {
      scanAndInject(onDownloadPlaylist);
    } catch {
      // Guard against stale observer firing after DOM cleanup
    }
  });

  activeObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Scan the page for playlist page and inject button if not already present.
 */
function scanAndInject(
  onDownloadPlaylist: (
    tracks: VkTrackMeta[],
    playlistTitle: string,
    progressCallback: (downloaded: number, total: number) => void,
  ) => void,
): void {
  // Guard against being called when document.body is not available
  if (!document.body) return;

  // Don't inject if button already exists in correct location
  const existingBtn = document.querySelector(`.${PLAYLIST_BTN_CLASS}`);
  if (existingBtn && document.body.contains(existingBtn)) {
    // If button is inside player (wrong place), remove it
    if (existingBtn.closest('.AudioPlayerBlock__root, [class*="AudioPlayerBlock"], [class*="TopAudioPlayer"], [class*="topAudioPlayer"]')) {
      existingBtn.remove();
    } else {
      return;
    }
  }

  // Strategy 1: Find actions container by known class patterns (ONLY on playlist pages)
  const actionSelectors = [
    '[class*="AudioListHeader__actions"]',
    '[class*="AudioPlaylist__actions"]',
    '[class*="AudioPlaylistSnippet__actions"]',
    '[class*="PlaylistPage__buttons"]',
    '[class*="playlistPage__buttons"]',
    '[class*="audio_page_block__actions"]',
    '[class*="playlist__actions"]',
  ];

  for (const selector of actionSelectors) {
    const actionsEl = document.querySelector(selector);
    if (actionsEl) {
      // Don't inject if inside player
      if (actionsEl.closest('.AudioPlayerBlock__root, [class*="AudioPlayerBlock"], [class*="TopAudioPlayer"]')) continue;
      injectButton(actionsEl as HTMLElement, onDownloadPlaylist);
      return;
    }
  }

  // Strategy 2: Find the "Слушать" button on playlist page (NOT in player)
  const allButtons = document.querySelectorAll("button, [role='button']");
  for (const btn of allButtons) {
    const text = btn.textContent?.trim();
    if (text === "Слушать" || text === "Слушать всё") {
      // Skip if inside player
      if (btn.closest('.AudioPlayerBlock__root, [class*="AudioPlayerBlock"], [class*="TopAudioPlayer"], [class*="topAudioPlayer"], [class*="vkitTopAudioPlayer"]')) continue;
      const buttonGroup = btn.closest('[class*="ButtonGroup"]') as HTMLElement | null;
      if (buttonGroup) {
        // Verify this ButtonGroup is NOT inside the player
        if (buttonGroup.closest('.AudioPlayerBlock__root, [class*="AudioPlayerBlock"], [class*="TopAudioPlayer"], [class*="vkitTopAudioPlayer"]')) continue;
        injectButton(buttonGroup, onDownloadPlaylist);
        return;
      }
    }
  }

  // Don't fallback to Strategy 3 — avoid injecting into wrong place
}

/**
 * Get playlist tracks via page-bridge (VK player API).
 * Limits to the playlist size shown on page if detectable.
 */
function getPlaylistTracksFromBridge(): Promise<VkTrackMeta[]> {
  return new Promise((resolve) => {
    const requestId = `ymus_pl_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Try to detect expected track count from DOM ("Треки 22" or "Треки 40")
    let expectedCount = 0;
    const trackCountSelectors = [
      '[class*="AudioListHeader__title"]',
      '[class*="audio_page_block__title"]',
      '[class*="MusicPlaylistStatistics__text"]',
      '[class*="vkitMusicPlaylistStatistics"]',
    ];
    for (const sel of trackCountSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const match = el.textContent?.match(/(?:Треки|Треков|треков?)\s*(\d+)/i) || el.textContent?.match(/(\d+)/);
        if (match) {
          expectedCount = parseInt(match[1], 10);
          break;
        }
      }
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail && detail.requestId === requestId) {
        document.removeEventListener("ymus-playlist-tracks-result", handler);
        let tracks: VkTrackMeta[] = (detail.tracks || []).map((t: any) => ({
          ownerId: t.ownerId,
          audioId: t.audioId,
          artist: t.artist,
          title: t.title,
          encryptedUrl: t.url || undefined,
        }));
        // Limit to expected count if detected (player may return more tracks from full library)
        if (expectedCount > 0 && tracks.length > expectedCount) {
          console.log(`[YMus] Limiting tracks from ${tracks.length} to ${expectedCount} (DOM header count)`);
          tracks = tracks.slice(0, expectedCount);
        }
        console.log(`[YMus] getPlaylistTracksFromBridge: expectedCount=${expectedCount}, returning ${tracks.length} tracks`);
        resolve(tracks);
      }
    };
    document.addEventListener("ymus-playlist-tracks-result", handler);

    document.dispatchEvent(
      new CustomEvent("ymus-get-playlist-tracks", { detail: { requestId } })
    );

    setTimeout(() => {
      document.removeEventListener("ymus-playlist-tracks-result", handler);
      resolve([]);
    }, 5000);
  });
}

/** Selectors for playlist container elements */
const PLAYLIST_CONTAINER_SELECTORS = [
  '[class*="AudioPlaylist__list"]',
  '[class*="AudioPlaylist__root"]',
  '[class*="audio_page_block"]',
  '[class*="PlaylistPage"]',
  '[class*="MusicPlaylistPageContent"]',
];

/**
 * Find the nearest playlist container element to scope DOM parsing.
 * Returns null if no container found (will fall back to document-wide search).
 */
function findPlaylistContainer(): Element | null {
  for (const selector of PLAYLIST_CONTAINER_SELECTORS) {
    const container = document.querySelector(selector);
    if (container) return container;
  }
  return null;
}

/**
 * Check if an audio row element is marked as unavailable.
 * Checks CSS classes and aria-disabled attribute.
 */
function isTrackUnavailable(row: Element): boolean {
  const classList = row.className || "";
  if (
    classList.includes("audio_row__unavailable") ||
    classList.includes("disabled") ||
    classList.includes("Unavailable") ||
    classList.includes("unavailable")
  ) {
    return true;
  }
  if (row.getAttribute("aria-disabled") === "true") {
    return true;
  }
  return false;
}

/**
 * Collect tracks from DOM.
 * Strategy 1: vkit/React fiber props (new VK /music/playlist/ pages)
 * Strategy 2: Classic approach with data-full-id / data-sortable-id
 * Scopes search to the playlist container first; falls back to document-wide search.
 * Filters out unavailable tracks and reports skipped count.
 */
function collectTracksFromDOM(): { tracks: VkTrackMeta[]; skipped: number } {
  // Strategy 1: vkit React fiber props (new /music/playlist/ pages)
  const vkitResult = collectTracksFromVkitFiber();
  if (vkitResult.tracks.length > 0) {
    return vkitResult;
  }

  // Strategy 2: Classic DOM with data-full-id / data-sortable-id
  const tracks: VkTrackMeta[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  const scope: ParentNode = findPlaylistContainer() ?? document;
  console.log(`[YMus] Classic DOM: scope is ${scope === document ? "document" : (scope as Element).className?.substring(0, 50)}`);

  for (const selector of AUDIO_ROW_SELECTORS) {
    const rows = scope.querySelectorAll(selector);
    if (rows.length > 0) console.log(`[YMus] Classic DOM: selector "${selector}" found ${rows.length} rows`);
    for (const row of rows) {
      if (isTrackUnavailable(row)) {
        skipped++;
        continue;
      }
      const meta = extractVkTrackMeta(row);
      if (meta !== null) {
        const key = `${meta.ownerId}_${meta.audioId}`;
        if (!seen.has(key)) {
          seen.add(key);
          tracks.push(meta);
        }
      }
    }
  }

  return { tracks, skipped };
}

/**
 * Extract tracks from vkit React fiber props on new /music/playlist/ pages.
 * These pages use data-testid="MusicPlaylistTracks_MusicTrackRow" elements
 * with track metadata stored in React fiber memoizedProps.
 * 
 * IMPORTANT: Only searches for rows with data-testid="MusicPlaylistTracks_MusicTrackRow"
 * to avoid picking up tracks from recommendations or other sections.
 */
function collectTracksFromVkitFiber(): { tracks: VkTrackMeta[]; skipped: number } {
  const tracks: VkTrackMeta[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  // Only use the specific testid for playlist track rows — avoid generic vkitAudioRow
  // which can match tracks in recommendations, player queue, etc.
  const rows = document.querySelectorAll('[data-testid="MusicPlaylistTracks_MusicTrackRow"]');
  console.log(`[YMus] vkit fiber: found ${rows.length} MusicPlaylistTracks_MusicTrackRow elements`);
  if (rows.length === 0) return { tracks, skipped };

  for (const row of rows) {
    const trackData = extractTrackFromFiber(row);
    if (trackData === null) {
      console.log("[YMus] vkit fiber: extractTrackFromFiber returned null for row", row);
      continue;
    }

    if (trackData.isBlocked) {
      console.log(`[YMus] vkit fiber: skipping blocked track ${trackData.artist} - ${trackData.title}`);
      skipped++;
      continue;
    }

    const key = `${trackData.ownerId}_${trackData.audioId}`;
    if (!seen.has(key)) {
      seen.add(key);
      tracks.push({
        ownerId: trackData.ownerId,
        audioId: trackData.audioId,
        artist: trackData.artist,
        title: trackData.title,
        encryptedUrl: trackData.url || undefined,
      });
    }
  }

  return { tracks, skipped };
}

/**
 * Extract track metadata from a React fiber tree of a vkit audio row element.
 * Traverses up the fiber tree looking for memoizedProps.track.entity with
 * identity.id, identity.ownerId, title, authors.raw, isBlocked, url.
 */
function extractTrackFromFiber(element: Element): {
  ownerId: string;
  audioId: string;
  artist: string;
  title: string;
  isBlocked: boolean;
  url: string | null;
} | null {
  // Find React fiber key
  const fiberKey = Object.keys(element).find(
    (k) => k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance"),
  );
  if (!fiberKey) {
    console.log("[YMus] extractTrackFromFiber: no fiber key found. Keys:", Object.keys(element).filter(k => k.startsWith("__")).join(", "));
    return null;
  }

  const fiber = (element as any)[fiberKey];
  let current = fiber;

  // Traverse up the fiber tree looking for track prop
  for (let i = 0; i < 10; i++) {
    if (!current) break;
    const props = current.memoizedProps;
    if (props && props.track) {
      const track = props.track;
      const entity = track.entity;

      if (entity) {
        // Get identity from prototype chain (VK uses getters)
        const identity = getNestedProp(entity, "identity");
        const title = getNestedProp(entity, "title");
        const authors = getNestedProp(entity, "authors");
        const isBlocked = getNestedProp(entity, "isBlocked");
        const url = getNestedProp(entity, "url");
        const apiAudio = getNestedProp(entity, "apiAudio");

        if (identity && identity.id && identity.ownerId) {
          const artist =
            (apiAudio && apiAudio.artist) ||
            (authors && authors.raw) ||
            "Unknown";
          const trackTitle =
            (apiAudio && apiAudio.title) ||
            title ||
            "audio";

          return {
            ownerId: String(identity.ownerId),
            audioId: String(identity.id),
            artist,
            title: trackTitle,
            isBlocked: !!isBlocked,
            url: url || null,
          };
        }
      }

      // Fallback: try apiAudio directly on track
      if (track.apiAudio) {
        const api = track.apiAudio;
        if (api.owner_id && api.id) {
          return {
            ownerId: String(api.owner_id),
            audioId: String(api.id),
            artist: api.artist || "Unknown",
            title: api.title || "audio",
            isBlocked: !!(api.content_restricted && api.content_restricted > 0 && !api.url),
            url: api.url || null,
          };
        }
      }
    }
    current = current.return;
  }

  // Fallback: try to extract from DOM testids (title/artist text)
  const titleEl = element.querySelector('[data-testid="MusicTrackRow_Title"]');
  const artistEl = element.querySelector('[data-testid="MusicTrackRow_Authors"]');
  if (titleEl && artistEl) {
    // We have title/artist but no IDs — can't proceed without them
    console.log("[YMus] extractTrackFromFiber: found title/artist DOM but no IDs from fiber. Title:", titleEl.textContent?.trim(), "Artist:", artistEl.textContent?.trim());
    return null;
  }

  console.log("[YMus] extractTrackFromFiber: no track data found in fiber tree (traversed 10 levels)");
  return null;
}

/**
 * Safely get a property from an object, including prototype chain properties.
 */
function getNestedProp(obj: any, key: string): any {
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}

/**
 * Find the playlist title from the page.
 */
function findPlaylistTitle(button?: HTMLElement): string {
  // Strategy 1: Find title by data-testid (most reliable for overlay)
  if (button) {
    const modal = button.closest('[class*="ModalBox"], [class*="AudioListBoxHeader"]');
    if (modal) {
      const titleEl = modal.querySelector('[data-testid="MusicPlaylistModal_Title"]');
      if (titleEl) {
        const text = titleEl.textContent?.trim();
        if (text && text.length > 0 && text.length < 100) return text;
      }
    }
  }
  
  // Also try globally (in case closest didn't match)
  const modalTitle = document.querySelector('[data-testid="MusicPlaylistModal_Title"]');
  if (modalTitle) {
    const text = modalTitle.textContent?.trim();
    if (text && text.length > 0 && text.length < 100) return text;
  }

  // Strategy 2: Find title in the closest header container relative to the button
  if (button) {
    const header = button.closest('[class*="AudioListBoxHeader"], [class*="AudioPlaylist"], [class*="audio_pl"], [class*="ModalBox"]');
    if (header) {
      const titleEl = header.querySelector('[class*="vkitTextClamp"][class*="Title"], .audio_pl__title, [class*="AudioPlaylist__title"]');
      if (titleEl) {
        const text = titleEl.textContent?.trim();
        if (text && text.length > 0 && text.length < 100) return text;
      }
    }
  }

  // Strategy 2: Global selectors (for full-page playlist views)
  const titleSelectors = [
    '[class*="MusicPlaylistPageContent__breadcrumbs"] [class*="Breadcrumbs__item"]:last-child',
    '[class*="MusicPlaylistPageContent__header"] [class*="vkitTextClamp"]',
    '[class*="MusicPlaylistPageContent__header"] [class*="Headline"]',
    '[class*="AudioPlaylist__title"]',
    '[class*="PlaylistPage__title"]',
  ];

  for (const selector of titleSelectors) {
    try {
      const el = document.querySelector(selector);
      if (el) {
        const text = el.textContent?.trim();
        if (text && text.length > 0 && text.length < 100) return text;
      }
    } catch {}
  }

  // Fallback: page title
  const pageTitle = document.title?.trim();
  if (pageTitle && pageTitle.length > 0 && pageTitle.length < 100 && pageTitle !== "ВКонтакте" && pageTitle !== "Моя музыка") {
    return pageTitle;
  }

  return "Плейлист";
}

/** Inject playlist-button styles once. Uses a conic-gradient ring as a
 * background so we can drive the fill via --ymus-pl-pct. */
let playlistStylesInjected = false;
function injectPlaylistStyles(): void {
  if (playlistStylesInjected) return;
  playlistStylesInjected = true;
  const style = document.createElement("style");
  style.id = "ymus-vk-playlist-styles";
  style.textContent = `
    .ymus-vk-playlist-btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 14px;
      border: 1px solid #656e77;
      border-radius: 8px;
      background: transparent;
      color: #e1e3e6;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      margin-left: 8px;
      transition: background 0.15s, border-color 0.15s;
      overflow: hidden;
      --ymus-pl-pct: 0;
    }
    .ymus-vk-playlist-btn:disabled {
      cursor: default;
    }
    /* Fill bar: a left-anchored block whose width tracks --ymus-pl-pct.
     * Sits BEHIND the label via z-index. VK accent — blue. */
    .ymus-vk-playlist-btn::before {
      content: "";
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: calc(var(--ymus-pl-pct) * 1%);
      background: linear-gradient(90deg, rgba(113, 170, 235, 0.35), rgba(113, 170, 235, 0.55));
      transition: width 0.25s ease;
      pointer-events: none;
      z-index: 0;
    }
    .ymus-vk-playlist-btn > * {
      position: relative;
      z-index: 1;
    }
    .ymus-vk-playlist-btn.ymus-pl-loading {
      color: #fff !important;
      border-color: #71aaeb !important;
    }
    /* Done state — green check + matching tint, mirrors per-track button */
    .ymus-vk-playlist-btn.ymus-pl-done {
      color: #4bb34b !important;
      border-color: #4bb34b !important;
    }
    .ymus-vk-playlist-btn.ymus-pl-done::before {
      background: rgba(75, 179, 75, 0.25);
    }
  `;
  document.head.appendChild(style);
}

/**
 * Create and inject the "Скачать плейлист" button.
 */
function injectButton(
  container: HTMLElement,
  onDownloadPlaylist: (
    tracks: VkTrackMeta[],
    playlistTitle: string,
    progressCallback: (downloaded: number, total: number, currentTrackPct?: number) => void,
  ) => void,
): void {
  injectPlaylistStyles();

  const button = document.createElement("button");
  button.className = PLAYLIST_BTN_CLASS;
  button.textContent = "Скачать плейлист";

  button.addEventListener("click", async () => {
    try {
      await handlePlaylistClick(button, onDownloadPlaylist);
    } catch (err) {
      resetPlaylistButton(button);
      showVkError(VK_ERROR_CODES.PLAYLIST_EXCEPTION, undefined, {
        err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
      });
    }
  });

  container.appendChild(button);
}

function resetPlaylistButton(button: HTMLButtonElement): void {
  button.disabled = false;
  button.textContent = "Скачать плейлист";
  button.classList.remove("ymus-pl-loading", "ymus-pl-done");
  button.style.setProperty("--ymus-pl-pct", "0");
}

/**
 * Handle click on the playlist download button.
 */
async function handlePlaylistClick(
  button: HTMLButtonElement,
  onDownloadPlaylist: (
    tracks: VkTrackMeta[],
    playlistTitle: string,
    progressCallback: (downloaded: number, total: number, currentTrackPct?: number) => void,
  ) => void,
): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add("ymus-pl-loading");
  button.textContent = "Загрузка списка…";

  // Collect tracks from DOM (primary source — reliable metadata via extractVkTrackMeta)
  console.log("[YMus] Playlist download: collecting tracks from DOM...");
  let { tracks: domTracks, skipped } = collectTracksFromDOM();
  let tracks = domTracks;
  console.log(`[YMus] DOM strategy result: ${tracks.length} tracks, ${skipped} skipped`);
  if (tracks.length > 0) {
    console.log("[YMus] First track:", tracks[0].artist, "-", tracks[0].title);
  }

  // If DOM returned 0, try page-bridge (which runs in main world and can access React fiber)
  if (tracks.length === 0) {
    console.log("[YMus] DOM strategies returned 0, trying page-bridge (fiber + player API)...");
    tracks = await getPlaylistTracksFromBridge();
    console.log(`[YMus] Page-bridge result: ${tracks.length} tracks`);
    if (tracks.length > 0) {
      console.log("[YMus] First track from bridge:", tracks[0].artist, "-", tracks[0].title);
    }
  }

  if (tracks.length === 0) {
    resetPlaylistButton(button);
    showVkError(VK_ERROR_CODES.PLAYLIST_NO_TRACKS, undefined, {
      url: location.href,
      domStrategiesTried: ["AUDIO_ROW_SELECTORS", "fiber", "page-bridge"],
    });
    return;
  }

  const playlistTitle = findPlaylistTitle(button);
  const total = tracks.length;

  const skippedMsg = skipped > 0 ? ` (${skipped} недоступных пропущено)` : "";

  // Show toast with skipped count info
  if (skipped > 0) {
    const toast = document.createElement("div");
    toast.textContent = `Скачивание: ${total} треков${skippedMsg}`;
    toast.style.cssText = `position:fixed;bottom:24px;right:24px;background:#1d1d1f;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.3);`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // Initial state — 0% before the first byte arrives.
  button.style.setProperty("--ymus-pl-pct", "0");
  button.textContent = `0%`;

  /**
   * Combined progress: completed-tracks share + a partial slice for the
   * track currently in flight. So a 70-track playlist with 13 finished
   * and the 14th at 60% reads as ((13 + 0.6) / 70) * 100 ≈ 19%.
   */
  const progressCallback = (downloaded: number, totalCount: number, currentTrackPct?: number): void => {
    const safePartial = currentTrackPct !== undefined && downloaded < totalCount
      ? Math.max(0, Math.min(100, currentTrackPct)) / 100
      : 0;
    const overall = totalCount > 0
      ? Math.min(100, Math.round(((downloaded + safePartial) / totalCount) * 100))
      : 0;
    button.style.setProperty("--ymus-pl-pct", String(overall));
    button.textContent = `${overall}%`;

    if (downloaded >= totalCount) {
      // Finished — flash a green check + "Готово" label, then reset.
      button.classList.remove("ymus-pl-loading");
      button.classList.add("ymus-pl-done");
      button.style.setProperty("--ymus-pl-pct", "100");
      button.textContent = "✓ Готово";
      setTimeout(() => resetPlaylistButton(button), 2000);
    }
  };

  onDownloadPlaylist(tracks, playlistTitle, progressCallback);
}
