// Feature: download-buttons-everywhere
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10,
//               5.1, 5.3, 5.4, 5.5, 5.6, 6.6, 7.1, 7.2, 7.6,
//               8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8,
//               9.1, 9.4, 9.5, 9.6, 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 10.8,
//               12.1, 12.2, 12.3, 12.4, 12.5
//
// Кнопки скачивания для строк треков на странице поиска (/search).
// Реюзит findActionsContainer, TRACK_BUTTON_STATES, ICON_DOWNLOAD_SMALL,
// flashOverlayButton из track-row-injector.ts.
// Активен только на pathname /^\/search(?:\/.*)?$/.

import {
  findActionsContainer,
  TRACK_BUTTON_STATES,
  ICON_DOWNLOAD_SMALL,
  ICON_LOADING_SPINNER,
  ICON_CHECK_WHITE,
  INJECTED_ATTR,
  STATE_ATTR,
  flashOverlayButton,
  type TrackButtonState,
} from "./track-row-injector";
import { observeURLChanges } from "./url-observer";
import { downloadTrackWithTags } from "./downloader";
import { getFormatPreferences } from "../shared/format-storage";
import { classifyCardHref, DOWNLOADABLE_CATEGORIES, buildAlbumIdentifierUrl, type CardIdentifier } from "./card-classifier";
import { startProgressRing, clearProgressRing } from "./progress-ring";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SearchTrackInjectorOptions {
  notify(text: string, kind: "success" | "error" | "info"): void;
}

export interface SearchTrackInjectorHandle {
  stop(): void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SEARCH_PATHNAME_RE = /^\/search(?:\/.*)?$/;

const TRACK_ROW_SELECTORS: readonly string[] = [
  "[class*='Track_root']",
  "[class*='TrackRow']",
  "[class*='trackItem']",
  "[class*='d-track']",
  "[class*='CommonTrack_root']",
  ".d-track",
];

const TRACK_LINK_REGEX = /\/track\/(\d+)/;

/** Re-evaluation cap: 150 evaluations within 15 000 ms after last pathname change. */
const EVAL_CAP_LIMIT = 150;
const EVAL_CAP_WINDOW_MS = 15_000;

const DEBOUNCE_MS = 200;
const INTERVAL_MS = 2000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractTrackIdFromRow(row: Element): string | null {
  const trackLink = row.querySelector('a[href*="/track/"]');
  if (trackLink !== null) {
    const href = (trackLink as HTMLAnchorElement).getAttribute("href") ?? "";
    const m = href.match(TRACK_LINK_REGEX);
    if (m !== null) return m[1];
  }
  return null;
}

function extractMetaFromRow(row: Element): { artist?: string; title?: string } | undefined {
  try {
    const titleEl = row.querySelector(
      '[class*="TrackTitle"], [class*="track__title"], [class*="Track_title"]',
    );
    const artistEls = row.querySelectorAll(
      '[class*="TrackArtist"] a, [class*="track__artists"] a, [class*="Track_artists"] a',
    );

    const title = titleEl?.textContent?.trim();
    const artists = Array.from(artistEls)
      .map((el) => el.textContent?.trim() ?? "")
      .filter((n) => n.length > 0);

    if ((title && title.length > 0) || artists.length > 0) {
      return {
        title: title && title.length > 0 ? title : undefined,
        artist: artists.length > 0 ? artists.join(", ") : undefined,
      };
    }
  } catch {
    // ignore
  }
  return undefined;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export function startSearchTrackInjector(
  options: SearchTrackInjectorOptions,
): SearchTrackInjectorHandle {
  const { notify } = options;

  let stopped = false;
  let debounceTimer = 0;
  let intervalHandle = 0;
  let observer: MutationObserver | null = null;

  // Re-evaluation cap state (Req 8.8)
  let evalCount = 0;
  let evalWindowStart = Date.now();

  function resetEvalCap(): void {
    evalCount = 0;
    evalWindowStart = Date.now();
  }

  function isWithinEvalCap(): boolean {
    const now = Date.now();
    if (now - evalWindowStart > EVAL_CAP_WINDOW_MS) {
      // Window expired — reset and allow
      resetEvalCap();
      return true;
    }
    return evalCount < EVAL_CAP_LIMIT;
  }

  function isSearchPage(): boolean {
    return SEARCH_PATHNAME_RE.test(location.pathname);
  }

  function buildButton(trackId: string, row: Element): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-ymd-track-id", trackId);
    btn.setAttribute(INJECTED_ATTR, "1");
    btn.setAttribute(STATE_ATTR, "idle");
    btn.setAttribute("aria-label", TRACK_BUTTON_STATES.idle.ariaLabel);
    btn.title = TRACK_BUTTON_STATES.idle.ariaLabel;

    btn.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;color:${TRACK_BUTTON_STATES.idle.iconColor};">${ICON_DOWNLOAD_SMALL}</span>`;

    // Styling: 20×20 round yellow button
    btn.style.width = "20px";
    btn.style.height = "20px";
    btn.style.minWidth = "20px";
    btn.style.padding = "0";
    btn.style.background = TRACK_BUTTON_STATES.idle.background;
    btn.style.color = TRACK_BUTTON_STATES.idle.iconColor;
    btn.style.border = "none";
    btn.style.borderRadius = "50%";
    btn.style.cursor = "pointer";
    btn.style.display = "inline-flex";
    btn.style.alignItems = "center";
    btn.style.justifyContent = "center";
    btn.style.verticalAlign = "middle";
    btn.style.flexShrink = "0";
    btn.style.alignSelf = "center";
    btn.style.marginRight = "8px";
    btn.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.2)";
    btn.style.transition = "background 0.12s, transform 0.1s";

    btn.addEventListener("mouseenter", () => {
      if (btn.getAttribute(STATE_ATTR) === "idle") {
        btn.style.background = "#ffff66";
      }
      btn.style.transform = "scale(1.08)";
    });
    btn.addEventListener("mouseleave", () => {
      if (btn.getAttribute(STATE_ATTR) === "idle") {
        btn.style.background = TRACK_BUTTON_STATES.idle.background;
      }
      btn.style.transform = "scale(1)";
    });

    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const currentState = btn.getAttribute(STATE_ATTR) as TrackButtonState | null;
      if (currentState === "loading" || currentState === "success") {
        return;
      }

      const id = btn.getAttribute("data-ymd-track-id");
      if (id === null) return;

      void handleClick(id, btn, row);
    });

    return btn;
  }

  async function handleClick(
    trackId: string,
    btn: HTMLButtonElement,
    row: Element,
  ): Promise<void> {
    // Read format preferences once per click (Req 5.1)
    let format: string = "mp3";
    try {
      const prefs = await getFormatPreferences();
      format = prefs.singleTrackFormat;
    } catch {
      // Fall back to "mp3" on error (Req 5.2)
      format = "mp3";
    }

    // Set loading state
    flashOverlayButton(btn, "loading");

    // Extract meta hint from the row
    const metaHint = extractMetaFromRow(row);

    try {
      const result = await downloadTrackWithTags(trackId, metaHint, undefined);

      if (result.success && typeof result.downloadId === "number") {
        flashOverlayButton(btn, "success");
      } else {
        flashOverlayButton(btn, "error");
        if (result.reason) {
          notify(result.reason, "error");
        }
      }
    } catch (e) {
      flashOverlayButton(btn, "error");
      notify(
        e instanceof Error ? e.message : "Ошибка скачивания",
        "error",
      );
    }
  }

  /**
   * Находит контейнер для вставки кнопки в строке трека поиска.
   * 
   * В поиске layout отличается от обычного плейлиста:
   * кнопки действий (лайк) могут не попадать в "правую половину" по
   * getBoundingClientRect. Поэтому используем fallback-стратегию:
   * 1. Пробуем стандартный findActionsContainer
   * 2. Ищем кнопку лайка по классу
   * 3. Ищем любую кнопку с SVG (вероятно лайк)
   * 4. Ищем элемент длительности и вставляем перед ним
   * 5. Крайний fallback — ищем обёртку правой части строки
   */
  function findInsertionPoint(row: Element): {
    container: HTMLElement;
    insertBefore: Element | null;
  } | null {
    // Strategy 1: standard findActionsContainer (works on playlist/album pages)
    const found = findActionsContainer(row);
    if (found !== null) {
      return { container: found.container, insertBefore: found.firstChild };
    }

    // Strategy 2: find the like button by class name
    const likeBtn = row.querySelector(
      'button[class*="Like"], button[class*="like"], ' +
      '[class*="LikeButton"], [class*="likeButton"]'
    );
    if (likeBtn !== null && likeBtn.parentElement !== null) {
      return { container: likeBtn.parentElement as HTMLElement, insertBefore: likeBtn };
    }

    // Strategy 3: find any interactive button in the row (likely like/more)
    const allButtons = row.querySelectorAll("button");
    for (const btn of Array.from(allButtons)) {
      // Skip play buttons (they are usually larger or have specific classes)
      const classes = btn.className ?? "";
      if (classes.includes("Play") || classes.includes("play")) continue;
      if (btn.parentElement !== null) {
        return { container: btn.parentElement as HTMLElement, insertBefore: btn };
      }
    }

    // Strategy 4: find duration/time element
    const durationEl = row.querySelector(
      '[class*="Duration"], [class*="duration"], [class*="time"]'
    );
    if (durationEl !== null && durationEl.parentElement !== null) {
      return { container: durationEl.parentElement as HTMLElement, insertBefore: durationEl };
    }

    // Strategy 5: insert at the end of the row
    if (row instanceof HTMLElement) {
      return { container: row, insertBefore: null };
    }

    return null;
  }

  function injectIntoRow(row: Element): void {
    // Skip if already has injected button (idempotence)
    if (row.querySelector(`[${INJECTED_ATTR}="1"]`) !== null) return;

    const trackId = extractTrackIdFromRow(row);
    if (trackId === null) return;

    const insertion = findInsertionPoint(row);
    if (insertion === null) return;

    const { container, insertBefore } = insertion;
    const btn = buildButton(trackId, row);

    // Place before the found element (Req 1.3: left of like button)
    container.insertBefore(btn, insertBefore);
  }

  function scan(): void {
    if (stopped) return;
    if (!isSearchPage()) return;
    if (!isWithinEvalCap()) return;

    evalCount++;

    const seen = new Set<Element>();
    for (const selector of TRACK_ROW_SELECTORS) {
      let rows: NodeListOf<Element>;
      try {
        rows = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const row of Array.from(rows)) {
        if (seen.has(row)) continue;
        seen.add(row);
        injectIntoRow(row);
      }
    }

    // Also scan EntityCards (small album/single cards in search results)
    scanEntityCards();
  }

  // ─── Entity Card scanning (album/playlist cards in search) ──────────────

  const ENTITY_CARD_SELECTORS: readonly string[] = [
    "[class*='EntityCard_root']",
    "[class*='HorizontalCardContainer_root']",
  ];

  const ENTITY_INJECTED_ATTR = "data-ymd-entity-injected";

  function scanEntityCards(): void {
    for (const selector of ENTITY_CARD_SELECTORS) {
      let cards: NodeListOf<Element>;
      try {
        cards = document.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const card of Array.from(cards)) {
        injectIntoEntityCard(card);
      }
    }
  }

  function injectIntoEntityCard(card: Element): void {
    // Skip if already injected
    if (card.querySelector(`[${ENTITY_INJECTED_ATTR}="1"]`) !== null) return;
    // Also skip if track-row injector already handled this
    if (card.querySelector(`[${INJECTED_ATTR}="1"]`) !== null) return;

    // Find the album/playlist href (try multiple link patterns)
    let href: string | null = null;
    const albumLink = card.querySelector('a[href*="/album/"]') as HTMLAnchorElement | null;
    if (albumLink !== null) {
      href = albumLink.getAttribute("href");
    }
    if (href === null) {
      const playlistLink = card.querySelector('a[href*="/playlists/"], a[href*="/users/"][href*="/playlists/"]') as HTMLAnchorElement | null;
      if (playlistLink !== null) {
        href = playlistLink.getAttribute("href");
      }
    }
    // Fallback: any link with href (may contain /album/X/track/Y)
    if (href === null) {
      const anyLink = card.querySelector('a[href]') as HTMLAnchorElement | null;
      if (anyLink !== null) {
        const h = anyLink.getAttribute("href") ?? "";
        if (h.includes("/album/") || h.includes("/playlists/")) {
          href = h;
        }
      }
    }
    if (href === null || href === "") return;

    // Check if this is a single track (href like /album/X/track/Y)
    const trackMatch = href.match(/\/album\/\d+\/track\/(\d+)/);
    if (trackMatch) {
      // This is a single track — use downloadTrackWithTags, not bulk
      const trackId = trackMatch[1];
      injectTrackEntityButton(card, trackId);
      return;
    }

    // Classify — for album/playlist URLs
    const classification = classifyCardHref(href);
    if (!DOWNLOADABLE_CATEGORIES.has(classification.category)) return;
    if (classification.identifier === null) return;

    // Find the cover image to insert before
    const coverImg = card.querySelector("img");
    if (coverImg === null) return;

    // Walk up to find the playButtonCell / cover wrapper
    let coverWrapper: HTMLElement | null = coverImg.parentElement;
    // Go up at most 2 levels to find the direct child of card
    for (let i = 0; i < 3 && coverWrapper !== null; i++) {
      if (coverWrapper.parentElement === card) break;
      coverWrapper = coverWrapper.parentElement;
    }
    if (coverWrapper === null) return;

    // Build the download button
    const btn = buildEntityButton(classification.identifier, card);

    // Insert before the cover wrapper (left of cover)
    (card as HTMLElement).insertBefore(btn, coverWrapper);
  }

  /**
   * Injects a single-track download button for entity cards with /track/ URLs.
   * Uses downloadTrackWithTags (same as normal track rows) — no folder, no bulk.
   */
  function injectTrackEntityButton(card: Element, trackId: string): void {
    // Find the cover image to insert before
    const coverImg = card.querySelector("img");
    if (coverImg === null) return;

    let coverWrapper: HTMLElement | null = coverImg.parentElement;
    for (let i = 0; i < 3 && coverWrapper !== null; i++) {
      if (coverWrapper.parentElement === card) break;
      coverWrapper = coverWrapper.parentElement;
    }
    if (coverWrapper === null) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(ENTITY_INJECTED_ATTR, "1");
    btn.setAttribute(STATE_ATTR, "idle");
    btn.setAttribute("data-ymd-track-id", trackId);
    btn.setAttribute("aria-label", TRACK_BUTTON_STATES.idle.ariaLabel);
    btn.title = TRACK_BUTTON_STATES.idle.ariaLabel;

    btn.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;color:${TRACK_BUTTON_STATES.idle.iconColor};">${ICON_DOWNLOAD_SMALL}</span>`;

    btn.style.cssText = [
      "width: 20px",
      "height: 20px",
      "min-width: 20px",
      "padding: 0",
      "background: #ffff00",
      "color: #1d1d1f",
      "border: none",
      "border-radius: 50%",
      "cursor: pointer",
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "vertical-align: middle",
      "flex-shrink: 0",
      "align-self: center",
      "margin-right: 6px",
      "box-shadow: 0 1px 2px rgba(0,0,0,0.2)",
      "transition: background 0.12s, transform 0.1s",
    ].join("; ");

    btn.addEventListener("mouseenter", () => {
      if (btn.getAttribute(STATE_ATTR) === "idle") btn.style.background = "#ffff66";
      btn.style.transform = "scale(1.08)";
    });
    btn.addEventListener("mouseleave", () => {
      if (btn.getAttribute(STATE_ATTR) === "idle") btn.style.background = "#ffff00";
      btn.style.transform = "scale(1)";
    });

    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const st = btn.getAttribute(STATE_ATTR) as TrackButtonState | null;
      if (st === "loading" || st === "success") return;
      void handleClick(trackId, btn, card);
    });

    (card as HTMLElement).insertBefore(btn, coverWrapper);
  }

  function buildEntityButton(
    identifier: NonNullable<CardIdentifier>,
    card: Element,
  ): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(ENTITY_INJECTED_ATTR, "1");
    btn.setAttribute(STATE_ATTR, "idle");
    btn.setAttribute("aria-label", "Скачать");
    btn.title = "Скачать";

    btn.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;color:${TRACK_BUTTON_STATES.idle.iconColor};">${ICON_DOWNLOAD_SMALL}</span>`;

    // Style: 20×20 yellow button, inline
    btn.style.cssText = [
      "width: 20px",
      "height: 20px",
      "min-width: 20px",
      "padding: 0",
      "background: #ffff00",
      "color: #1d1d1f",
      "border: none",
      "border-radius: 50%",
      "cursor: pointer",
      "display: inline-flex",
      "align-items: center",
      "justify-content: center",
      "vertical-align: middle",
      "flex-shrink: 0",
      "align-self: center",
      "margin-right: 6px",
      "box-shadow: 0 1px 2px rgba(0,0,0,0.2)",
      "transition: background 0.12s, transform 0.1s",
    ].join("; ");

    btn.addEventListener("mouseenter", () => {
      if (btn.getAttribute(STATE_ATTR) === "idle") {
        btn.style.background = "#ffff66";
      }
      btn.style.transform = "scale(1.08)";
    });
    btn.addEventListener("mouseleave", () => {
      if (btn.getAttribute(STATE_ATTR) === "idle") {
        btn.style.background = "#ffff00";
      }
      btn.style.transform = "scale(1)";
    });

    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      const currentState = btn.getAttribute(STATE_ATTR) as TrackButtonState | null;
      if (currentState === "loading" || currentState === "success") return;

      void handleEntityClick(btn, identifier, extractEntityTrackTitle(card));
    });

    return btn;
  }

  /** Extracts the track/album title from an EntityCard DOM element. */
  function extractEntityTrackTitle(card: Element): string {
    // Try EntityCard title link
    const titleLink = card.querySelector('[class*="EntityCard_titleLink"], [class*="EntityCard_text"]');
    if (titleLink !== null) {
      const text = (titleLink.textContent ?? "").trim();
      if (text.length > 0) return text;
    }
    // Try EntityMeta title
    const metaTitle = card.querySelector('[class*="EntityMeta_title"]');
    if (metaTitle !== null) {
      const text = (metaTitle.textContent ?? "").trim();
      if (text.length > 0) return text;
    }
    // Fallback to aria-label (format: "artists trackname")
    const ariaLabel = card.getAttribute("aria-label") ?? "";
    return ariaLabel;
  }

  async function handleEntityClick(
    btn: HTMLButtonElement,
    identifier: NonNullable<CardIdentifier>,
    trackTitle: string,
  ): Promise<void> {
    // Set loading state
    btn.setAttribute(STATE_ATTR, "loading");
    btn.style.background = TRACK_BUTTON_STATES.loading.background;
    btn.setAttribute("aria-label", "Скачивание...");
    const span = btn.querySelector("span");
    // Show the download icon (NOT a spinner) — startProgressRing draws the
    // conic ring around it for the visual "loading" affordance.
    if (span) span.innerHTML = ICON_DOWNLOAD_SMALL;
    const ringHandle = startProgressRing(btn);

    // Resolve the album, find the specific track by title, download it
    try {
      const inputUrl = buildAlbumIdentifierUrl(identifier);
      const messageType = identifier.kind === "album" ? "RESOLVE_ALBUM" : "RESOLVE_PLAYLIST";

      const response = await chrome.runtime.sendMessage({
        type: messageType,
        payload: { input: inputUrl },
      }) as { success?: boolean; album?: { trackIds: string[]; tracks?: Array<{ id: string; title: string }> }; playlist?: { trackIds: string[] }; errorCode?: string; reason?: string } | undefined;

      if (!response || !response.success) {
        ringHandle.abort();
        const reason = response?.reason ?? "Ошибка загрузки";
        notify(reason, "error");
        resetEntityBtn(btn);
        return;
      }

      const trackIds = response.album?.trackIds ?? response.playlist?.trackIds ?? [];
      const tracks = response.album?.tracks ?? [];

      if (trackIds.length === 0) {
        ringHandle.abort();
        notify("Треки не найдены", "error");
        resetEntityBtn(btn);
        return;
      }

      // Find the track by title match (case-insensitive)
      let targetTrackId: string | null = null;
      const normalizedTitle = trackTitle.toLowerCase().trim();

      if (tracks.length > 0 && normalizedTitle.length > 0) {
        for (const t of tracks) {
          if (t.title.toLowerCase().trim() === normalizedTitle) {
            targetTrackId = t.id;
            break;
          }
        }
        // Fuzzy fallback: partial match
        if (targetTrackId === null) {
          for (const t of tracks) {
            if (t.title.toLowerCase().includes(normalizedTitle) ||
                normalizedTitle.includes(t.title.toLowerCase())) {
              targetTrackId = t.id;
              break;
            }
          }
        }
      }

      // If no match found, fall back to first track
      if (targetTrackId === null) {
        targetTrackId = trackIds[0];
      }

      // Download the single track (no folder)
      const result = await downloadTrackWithTags(targetTrackId, undefined, undefined);

      if (result.success && typeof result.downloadId === "number") {
        ringHandle.complete();
        btn.setAttribute(STATE_ATTR, "success");
        btn.style.background = TRACK_BUTTON_STATES.success.background;
        btn.setAttribute("aria-label", TRACK_BUTTON_STATES.success.ariaLabel);
        if (span) {
          span.style.color = "#ffffff";
          span.innerHTML = ICON_CHECK_WHITE;
        }
        setTimeout(() => resetEntityBtn(btn), 1700);
      } else {
        ringHandle.abort();
        btn.setAttribute(STATE_ATTR, "error");
        btn.style.background = TRACK_BUTTON_STATES.error.background;
        if (result.reason) notify(result.reason, "error");
        setTimeout(() => resetEntityBtn(btn), 1500);
      }
    } catch (e) {
      ringHandle.abort();
      notify(e instanceof Error ? e.message : "Ошибка", "error");
      resetEntityBtn(btn);
    }
  }

  function resetEntityBtn(btn: HTMLButtonElement): void {
    clearProgressRing(btn);
    btn.setAttribute(STATE_ATTR, "idle");
    btn.style.background = TRACK_BUTTON_STATES.idle.background;
    btn.setAttribute("aria-label", "Скачать");
    btn.title = "Скачать";
    const s = btn.querySelector("span");
    if (s) {
      s.style.color = TRACK_BUTTON_STATES.idle.iconColor;
      s.innerHTML = ICON_DOWNLOAD_SMALL;
    }
  }

  function scheduleScan(): void {
    if (stopped) return;
    if (debounceTimer !== 0) return;
    debounceTimer = window.setTimeout(() => {
      debounceTimer = 0;
      scan();
    }, DEBOUNCE_MS);
  }

  // ─── Lifecycle: MutationObserver ─────────────────────────────────────────

  observer = new MutationObserver(() => {
    scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ─── Lifecycle: Safety-net interval ──────────────────────────────────────

  intervalHandle = window.setInterval(() => {
    if (!stopped) scan();
  }, INTERVAL_MS);

  // ─── Lifecycle: URLObserver ──────────────────────────────────────────────

  observeURLChanges((_newURL: string) => {
    // On pathname change, reset evaluation cap and schedule immediate scan
    resetEvalCap();
    scheduleScan();
  });

  // ─── Initial scan ────────────────────────────────────────────────────────

  scan();

  // ─── Stop handle ─────────────────────────────────────────────────────────

  return {
    stop(): void {
      stopped = true;
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
      if (intervalHandle !== 0) {
        window.clearInterval(intervalHandle);
        intervalHandle = 0;
      }
      if (debounceTimer !== 0) {
        window.clearTimeout(debounceTimer);
        debounceTimer = 0;
      }
    },
  };
}
