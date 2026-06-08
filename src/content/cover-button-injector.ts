/**
 * Cover_Hover_Button + Carousel_Card_Button injector.
 *
 * Один модуль обслуживает обе кнопки. Различие:
 *   - Cover_Hover_Button: скрыта до hover (CSS `opacity: 0`), marker `data-ymd-cover-injected="1"`.
 *   - Carousel_Card_Button: всегда видима, marker `data-ymd-card-injected="1"`.
 *
 * Requirements: 2.1–2.12, 3.1–3.11, 4.9, 4.10, 5.2–5.6, 6.1–6.5, 6.7,
 *               7.1–7.6, 8.1–8.8, 9.2–9.6, 10.1–10.8, 11.2–11.4, 12.1–12.7
 */

import { observeURLChanges } from "./url-observer";
import {
  classifyCardHref,
  DOWNLOADABLE_CATEGORIES,
  type CardCategory,
  type CardIdentifier,
} from "./card-classifier";
import { startBulkTrigger } from "./bulk-trigger";
import { getFormatPreferences } from "../shared/format-storage";
import {
  ICON_DOWNLOAD_SMALL,
  ICON_LOADING_SPINNER,
  ICON_CHECK_WHITE,
  type TrackButtonState,
} from "./track-row-injector";
import {
  startProgressRing,
  clearProgressRing,
  type ProgressRingHandle,
} from "./progress-ring";

// ─── Public types ────────────────────────────────────────────────────────────

export interface CoverButtonInjectorOptions {
  notify(text: string, kind: "success" | "error" | "info"): void;
  confirm?(message: string): boolean;
}

export interface CoverButtonInjectorHandle {
  stop(): void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const COVER_MARKER = "data-ymd-cover-injected";
const CARD_MARKER = "data-ymd-card-injected";
const STATE_ATTR = "data-ymd-state";

const ICON_ERROR_WHITE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

/** Six broad selectors to find Cover_Card / Carousel_Card elements (Req 2.1, 3.1). */
const COVER_CARD_SELECTORS: readonly string[] = [
  "[class*='AlbumCard']",
  "[class*='PlaylistCard']",
  "[class*='Cover_root']",
  "[class*='CardWrap']",
  "[class*='entityCard']",
  "[class*='EntityCard_root']",
  "[class*='CarouselItem']",
  "[class*='NewRelease_root']",
  "[class*='newRelease_root']",
  "[class*='HorizontalCardContainer_root']",
];

/** Aria-labels for Cover/Carousel buttons by category and state. */
export const COVER_BUTTON_LABELS: Record<
  "album" | "playlist-classic" | "playlist-uuid",
  Record<TrackButtonState, string>
> = {
  album: {
    idle: "Скачать альбом",
    loading: "Скачивание альбома",
    success: "Альбом скачан",
    error: "Ошибка скачивания",
  },
  "playlist-classic": {
    idle: "Скачать плейлист",
    loading: "Скачивание плейлиста",
    success: "Плейлист скачан",
    error: "Ошибка скачивания",
  },
  "playlist-uuid": {
    idle: "Скачать плейлист",
    loading: "Скачивание плейлиста",
    success: "Плейлист скачан",
    error: "Ошибка скачивания",
  },
};

const SUCCESS_DURATION_MS = 1700;
const ERROR_DURATION_MS = 1500;
const DEBOUNCE_MS = 200;
const SAFETY_NET_MS = 2000;

/** Re-evaluation cap: 150 evaluations within 15 000 ms after last pathname change. */
const REVAL_CAP = 150;
const REVAL_WINDOW_MS = 15_000;

// ─── WeakMap timer pattern (reused from track-row-injector.ts) ────────────────

const buttonTimers = new WeakMap<HTMLButtonElement, number>();

function clearPendingTimer(btn: HTMLButtonElement): void {
  const handle = buttonTimers.get(btn);
  if (handle !== undefined) {
    window.clearTimeout(handle);
    buttonTimers.delete(btn);
  }
}

// ─── Style injection (hover visibility for Cover_Hover_Button) ───────────────
//
// Cover_Hover_Button is hidden by default and revealed when the user hovers
// over the surrounding card. Yandex Music nests the cover image inside
// several wrapper divs that depend on the card kind, so a CSS-only
// `*:hover > marker` selector is too brittle (it relies on a fixed parent
// chain depth and breaks the moment Yandex tweaks markup). Instead we
// drive the visible state from a `data-ymd-hover-active` attribute that
// the JS hover binding toggles on the card root — the CSS rule then
// reveals every Cover_Hover_Button inside an active card regardless of
// nesting depth.
//
// Carousel_Card_Button (always visible) and Cover_Hover_Button on
// `:focus-visible` (keyboard focus reveal) bypass the data-attr gate.

let hoverStyleInjected = false;
const HOVER_STYLE_ID = "ymd-cover-hover-style";
const HOVER_ACTIVE_ATTR = "data-ymd-hover-active";

function ensureHoverStyle(): void {
  if (hoverStyleInjected) return;
  if (document.getElementById(HOVER_STYLE_ID) !== null) {
    hoverStyleInjected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = HOVER_STYLE_ID;
  style.textContent = `
    [${COVER_MARKER}="1"] {
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s;
    }
    [${HOVER_ACTIVE_ATTR}="1"] [${COVER_MARKER}="1"],
    [${COVER_MARKER}="1"]:focus-visible,
    [${COVER_MARKER}="1"]:hover {
      opacity: 1;
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);
  hoverStyleInjected = true;
}

/**
 * Bind `mouseenter`/`mouseleave` listeners to the host card so the
 * `data-ymd-hover-active` attribute toggles in sync with the user's
 * pointer. Idempotent — repeated calls on the same card are a no-op.
 *
 * Implementation note: `mouseenter`/`mouseleave` do NOT bubble (unlike
 * `mouseover`/`mouseout`), so the listener only fires for the actual
 * card root, not for every descendant the pointer crosses.
 */
const HOVER_BOUND_ATTR = "data-ymd-hover-bound";

function bindCardHover(card: HTMLElement): void {
  if (card.getAttribute(HOVER_BOUND_ATTR) === "1") return;
  card.setAttribute(HOVER_BOUND_ATTR, "1");
  card.addEventListener("mouseenter", () => {
    card.setAttribute(HOVER_ACTIVE_ATTR, "1");
  });
  card.addEventListener("mouseleave", () => {
    card.removeAttribute(HOVER_ACTIVE_ATTR);
  });
  // Keyboard focus inside the card also reveals — mirrors :focus-visible
  // for the button itself, but covers focus events on links / nested
  // controls that Yandex's own UI exposes.
  card.addEventListener("focusin", () => {
    card.setAttribute(HOVER_ACTIVE_ATTR, "1");
  });
  card.addEventListener("focusout", (event) => {
    // Only clear when focus leaves the card entirely.
    const next = (event as FocusEvent).relatedTarget as Node | null;
    if (next === null || !card.contains(next)) {
      card.removeAttribute(HOVER_ACTIVE_ATTR);
    }
  });
}

function ensureKeyframes(): void {
  if (document.getElementById("ymd-keyframes") !== null) return;
  const style = document.createElement("style");
  style.id = "ymd-keyframes";
  style.textContent = `
    @keyframes ymd-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determines whether a card element is inside a Carousel_Block.
 * Carousel blocks have class containing "Carousel" or are a scroll-snap region.
 */
function isInCarouselBlock(card: Element): boolean {
  if (card.closest("[class*='Carousel']") !== null) return true;
  const region = card.closest("[role='region']");
  if (region !== null) {
    const cs = window.getComputedStyle(region);
    if (cs.scrollSnapType && cs.scrollSnapType !== "none") return true;
  }
  return false;
}

/**
 * Finds the href from the first link inside a card that matches album/playlist patterns.
 */
function resolveCardHref(card: Element): string | null {
  const link = card.querySelector(
    'a[href*="/album/"], a[href*="/playlists/"], a[href*="/users/"][href*="/playlists/"]',
  ) as HTMLAnchorElement | null;
  if (link !== null) return link.getAttribute("href") ?? null;

  // Fallback: card itself may be a link
  if (card.tagName === "A") {
    return (card as HTMLAnchorElement).getAttribute("href") ?? null;
  }
  const anyLink = card.querySelector("a[href]") as HTMLAnchorElement | null;
  return anyLink?.getAttribute("href") ?? null;
}

/**
 * Finds the nearest carousel block title (when applicable).
 */
function resolveBlockTitle(card: Element): string | null {
  // Look for the carousel wrapper and its heading
  const carousel =
    card.closest("[class*='Carousel']") ?? card.closest("[role='region']");
  if (carousel === null) return null;

  // Try sibling or parent heading
  const parent = carousel.parentElement;
  if (parent === null) return null;

  const heading = parent.querySelector(
    "h1, h2, h3, h4, [class*='Title'], [class*='title'], [class*='Header']",
  );
  if (heading !== null) return heading.textContent?.trim() ?? null;

  return null;
}

// ─── Button state management ─────────────────────────────────────────────────

function getIconForState(state: TrackButtonState): string {
  switch (state) {
    case "idle":
      return ICON_DOWNLOAD_SMALL;
    case "loading":
      // No spinner — the progress-ring helper draws a conic ring around
      // the download icon while loading. See ./progress-ring.ts.
      return ICON_DOWNLOAD_SMALL;
    case "success":
      return ICON_CHECK_WHITE;
    case "error":
      return ICON_ERROR_WHITE;
  }
}

function getIconColorForState(state: TrackButtonState): string {
  switch (state) {
    case "idle":
      return "#1d1d1f";
    case "loading":
      // Yellow accent matches the conic ring color so a momentary flash
      // of the icon (before progress-ring hides it) blends in.
      return "#ffff00";
    case "success":
    case "error":
      return "#ffffff";
  }
}

function getBackgroundForState(state: TrackButtonState): string {
  switch (state) {
    case "idle":
      return "#ffff00";
    case "loading":
      // Dark transparent tint so the yellow conic ring + percent text
      // (drawn by progress-ring.ts) read clearly.
      return "rgba(255, 255, 0, 0.08)";
    case "success":
      return "#34c759";
    case "error":
      return "#ff453a";
  }
}

const coverRingHandles = new WeakMap<HTMLButtonElement, ProgressRingHandle>();

function applyButtonState(
  btn: HTMLButtonElement,
  state: TrackButtonState,
  category: "album" | "playlist-classic" | "playlist-uuid",
  progressLabel?: string,
): void {
  clearPendingTimer(btn);

  btn.setAttribute(STATE_ATTR, state);
  const label = progressLabel ?? COVER_BUTTON_LABELS[category][state];
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.style.background = getBackgroundForState(state);

  const span = btn.querySelector("span.ymd-cover-icon") as HTMLSpanElement | null;
  if (span !== null) {
    span.innerHTML = getIconForState(state);
    span.style.color = getIconColorForState(state);
  }

  // Update badge text for progress (e.g. "4/18 · 22%" set by handler).
  const badge = btn.querySelector("span.ymd-cover-badge") as HTMLSpanElement | null;
  if (badge !== null) {
    badge.textContent = progressLabel && state === "loading" ? progressLabel : "";
    badge.style.display = progressLabel && state === "loading" ? "block" : "none";
  }

  // Drive the progress ring around the cover-button icon based on state.
  if (state === "loading") {
    const prev = coverRingHandles.get(btn);
    if (prev !== undefined) prev.abort();
    coverRingHandles.set(btn, startProgressRing(btn));
    return;
  }

  if (state === "success") {
    const handle = coverRingHandles.get(btn);
    if (handle !== undefined) {
      handle.complete();
      coverRingHandles.delete(btn);
    }
    return;
  }

  // idle or error — tear down the ring entirely.
  const handle = coverRingHandles.get(btn);
  if (handle !== undefined) {
    handle.abort();
    coverRingHandles.delete(btn);
  }
  clearProgressRing(btn);
}

// ─── Button building ─────────────────────────────────────────────────────────

function buildCoverButton(
  category: "album" | "playlist-classic" | "playlist-uuid",
  identifier: NonNullable<CardIdentifier>,
  isCarousel: boolean,
  notify: CoverButtonInjectorOptions["notify"],
): HTMLButtonElement {
  ensureKeyframes();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute(isCarousel ? CARD_MARKER : COVER_MARKER, "1");
  btn.setAttribute(STATE_ATTR, "idle");
  btn.setAttribute("aria-label", COVER_BUTTON_LABELS[category].idle);
  btn.title = COVER_BUTTON_LABELS[category].idle;

  if (!isCarousel) {
    // Hover variant: set tabindex so it's tab-reachable even when parent isn't focused
    btn.setAttribute("tabindex", "0");
  }

  // Style: 32×32, border-radius: 50%, yellow background, dark icon
  btn.style.cssText = [
    "position: absolute",
    "top: 6px",
    "left: 6px",
    "z-index: 10",
    "padding: 0",
    "width: 32px",
    "height: 32px",
    "min-width: 32px",
    "background: #ffff00",
    "color: #1d1d1f",
    "border: none",
    "border-radius: 50%",
    "cursor: pointer",
    "pointer-events: auto",
    "display: inline-flex",
    "align-items: center",
    "justify-content: center",
    "flex-shrink: 0",
    "box-shadow: 0 1px 3px rgba(0,0,0,0.3)",
    "transition: background 0.15s, transform 0.12s, opacity 0.15s",
    "user-select: none",
  ].join("; ");

  // Icon span
  const iconSpan = document.createElement("span");
  iconSpan.className = "ymd-cover-icon";
  iconSpan.style.display = "inline-flex";
  iconSpan.style.alignItems = "center";
  iconSpan.style.justifyContent = "center";
  iconSpan.style.color = "#1d1d1f";
  iconSpan.innerHTML = ICON_DOWNLOAD_SMALL;
  btn.appendChild(iconSpan);

  // Badge span (for progress display)
  const badge = document.createElement("span");
  badge.className = "ymd-cover-badge";
  badge.style.cssText = [
    "display: none",
    "position: absolute",
    "bottom: -4px",
    "right: -4px",
    "font-size: 9px",
    "line-height: 1",
    "background: rgba(0,0,0,0.8)",
    "color: #fff",
    "border-radius: 6px",
    "padding: 1px 3px",
    "white-space: nowrap",
    "pointer-events: none",
  ].join("; ");
  btn.appendChild(badge);

  // Hover effects
  btn.addEventListener("mouseenter", () => {
    if (btn.getAttribute(STATE_ATTR) === "idle") {
      btn.style.background = "#ffff66";
    }
    btn.style.transform = "scale(1.08)";
  });
  btn.addEventListener("mouseleave", () => {
    const st = btn.getAttribute(STATE_ATTR) as TrackButtonState;
    btn.style.background = getBackgroundForState(st);
    btn.style.transform = "scale(1)";
  });

  // Click handler
  btn.addEventListener(
    "click",
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();

      const currentState = btn.getAttribute(STATE_ATTR) as TrackButtonState;
      // Ignore clicks in loading/success states
      if (currentState === "loading" || currentState === "success") return;

      // On idle or error: trigger bulk download
      handleCoverClick(btn, category, identifier, notify);
    },
    true,
  );

  return btn;
}

async function handleCoverClick(
  btn: HTMLButtonElement,
  category: "album" | "playlist-classic" | "playlist-uuid",
  identifier: NonNullable<CardIdentifier>,
  notify: CoverButtonInjectorOptions["notify"],
): Promise<void> {
  // Read Format_Preferences once per click (Req 5.2, 5.3, 5.5).
  // Cached for the duration of this click so format changes mid-cycle
  // do not reroute. Currently the SW reads format independently; this
  // snapshot is the canonical content-side read per Req 5.3.
  let bulkFormat: string = "mp3";
  try {
    const prefs = await getFormatPreferences();
    bulkFormat = prefs.bulkFormat;
  } catch {
    // Fall back to "mp3" silently (Req 5.2) — no extra toast
  }

  // Set loading state
  applyButtonState(btn, "loading", category);

  // Track progress to determine success/error on completion.
  // bulk-download.ts calls onIdle() at the end. If failed > 0 it also
  // calls notify() before onIdle(). We use this to distinguish outcomes.
  let lastDone = 0;
  let lastTotal = 0;
  let hadError = false;

  startBulkTrigger({
    identifier,
    callbacks: {
      notify: (text: string, kind: "success" | "error" | "info") => {
        if (kind === "error" && lastTotal > 0) {
          hadError = true;
        }
        notify(text, kind);
      },
      onProgress: (done: number, total: number) => {
        lastDone = done;
        lastTotal = total;
        // Show "4/18 · 22%" — track count plus the equivalent percentage,
        // matching the conic ring's fill so users can read either signal.
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const progressLabel = `${done}/${total} · ${pct}%`;
        applyButtonState(btn, "loading", category, progressLabel);
      },
      onIdle: () => {
        // Determine final state based on whether an error toast was shown
        if (lastTotal > 0 && !hadError) {
          // Success: all tracks downloaded without errors
          applyButtonState(btn, "success", category);
          const handle = window.setTimeout(() => {
            buttonTimers.delete(btn);
            if (!btn.isConnected) return;
            applyButtonState(btn, "idle", category);
          }, SUCCESS_DURATION_MS);
          buttonTimers.set(btn, handle);
        } else if (hadError) {
          // Error state (toast already shown by bulk-download)
          applyButtonState(btn, "error", category);
          const handle = window.setTimeout(() => {
            buttonTimers.delete(btn);
            if (!btn.isConnected) return;
            applyButtonState(btn, "idle", category);
          }, ERROR_DURATION_MS);
          buttonTimers.set(btn, handle);
        } else {
          // No progress was made (early exit, e.g. offline/auth error)
          applyButtonState(btn, "idle", category);
        }
      },
      confirm: (_message: string) => true,
    },
  });
}

// ─── Scan logic ──────────────────────────────────────────────────────────────

/**
 * Finds the cover/image container inside a card to inject the button into.
 * This ensures the button appears ON the cover image, not below it near the title.
 */
function findCoverElement(card: Element): HTMLElement | null {
  // Strategy 1: find an element with "Cover" or "cover" in class that contains an img
  const coverEl = card.querySelector(
    '[class*="Cover"], [class*="cover"], [class*="Image"], [class*="image"], [class*="Poster"], [class*="poster"]'
  );
  if (coverEl !== null && coverEl instanceof HTMLElement) {
    // Make sure this element actually has/is near an image
    if (coverEl.querySelector("img") !== null || coverEl.tagName === "IMG") {
      return coverEl;
    }
  }

  // Strategy 2: find a link that wraps an img
  const imgLink = card.querySelector("a > img, a > [class*='Cover']");
  if (imgLink !== null && imgLink.parentElement instanceof HTMLElement) {
    return imgLink.parentElement;
  }

  // Strategy 3: find any img's parent
  const img = card.querySelector("img");
  if (img !== null && img.parentElement instanceof HTMLElement) {
    return img.parentElement;
  }

  // Fallback: the card itself (but this might put button near title)
  return card instanceof HTMLElement ? card : null;
}

function scanCovers(notify: CoverButtonInjectorOptions["notify"]): void {
  const seen = new Set<Element>();

  for (const selector of COVER_CARD_SELECTORS) {
    let cards: NodeListOf<Element>;
    try {
      cards = document.querySelectorAll(selector);
    } catch {
      continue;
    }

    for (const card of Array.from(cards)) {
      if (seen.has(card)) continue;
      seen.add(card);

      // Detect NewReleaseCard: either this card or its ancestor
      const cardClassName = typeof (card as HTMLElement).className === "string" 
        ? (card as HTMLElement).className 
        : "";
      const isNewRelease = cardClassName.includes("NewReleaseCard") || cardClassName.includes("NewRelease_card");

      // If this card is INSIDE a NewReleaseCard but isn't one itself, skip
      // (let the NewRelease_root selector handle it)
      if (!isNewRelease && card.closest("[class*='NewReleaseCard']") !== null) continue;

      const inCarousel = isInCarouselBlock(card);
      const marker = inCarousel ? CARD_MARKER : COVER_MARKER;

      // Skip if already injected (check both on card and inside it)
      const existing = card.querySelector(`[${marker}="1"]`);
      if (existing !== null && existing.isConnected) continue;

      // Also check the other marker to prevent double injection
      const otherMarker = inCarousel ? COVER_MARKER : CARD_MARKER;
      const otherExisting = card.querySelector(`[${otherMarker}="1"]`);
      if (otherExisting !== null && otherExisting.isConnected) continue;

      // Skip if search-track-injector already handled this card
      if (card.querySelector('[data-ymd-entity-injected="1"]') !== null) continue;
      if (card.querySelector('[data-ymd-injected="1"]') !== null) continue;

      // Resolve href
      const href = resolveCardHref(card);
      if (href === null) continue;

      // Skip cards without a visible cover image (prevents injection into title-only elements)
      if (card.querySelector("img") === null && card.querySelector("[class*='Cover']") === null) continue;

      // Get block title for carousel disambiguation
      const parentBlockTitle = inCarousel ? resolveBlockTitle(card) : null;

      // Classify
      const classification = classifyCardHref(href, parentBlockTitle);

      // Skip non-downloadable categories
      if (!DOWNLOADABLE_CATEGORIES.has(classification.category)) continue;
      if (classification.identifier === null) continue;

      const category = classification.category as
        | "album"
        | "playlist-classic"
        | "playlist-uuid";

      // Build and inject button into the COVER element (not the full card)
      const button = buildCoverButton(
        category,
        classification.identifier,
        inCarousel,
        notify,
      );

      // Special handling for NewReleaseCard: insert button BEFORE the img as inline
      if (isNewRelease) {
        const img = card.querySelector("img");
        if (img !== null && card instanceof HTMLElement) {
          // For NewRelease, use CARD_MARKER so hover CSS doesn't hide it
          button.removeAttribute(COVER_MARKER);
          button.setAttribute(CARD_MARKER, "1");
          // Override button styling: inline, not absolute, always visible
          button.style.cssText = [
            "position: relative",
            "z-index: 10",
            "padding: 0",
            "width: 28px",
            "height: 28px",
            "min-width: 28px",
            "background: #ffff00",
            "color: #1d1d1f",
            "border: none",
            "border-radius: 50%",
            "cursor: pointer",
            "display: inline-flex",
            "align-items: center",
            "justify-content: center",
            "flex-shrink: 0",
            "vertical-align: middle",
            "margin-right: 6px",
            "box-shadow: 0 1px 3px rgba(0,0,0,0.3)",
            "transition: background 0.15s, transform 0.12s",
            "user-select: none",
            "opacity: 1",
            "pointer-events: auto",
          ].join("; ");
          card.insertBefore(button, img);
        } else {
          card.appendChild(button);
        }
      } else {
        // Standard flow: inject into the cover/image container
        const coverEl = findCoverElement(card);
        const targetEl = coverEl ?? (card instanceof HTMLElement ? card : null);
        if (targetEl === null) continue;

        // Ensure target has position: relative for absolute positioning of button
        const targetStyle = window.getComputedStyle(targetEl);
        if (
          targetStyle.position === "static" ||
          targetStyle.position === ""
        ) {
          targetEl.style.position = "relative";
        }

        // Also ensure overflow is visible so button doesn't get clipped
        if (targetStyle.overflow === "hidden") {
          targetEl.style.overflow = "visible";
        }

        targetEl.appendChild(button);
      }

      // Inject hover style for non-carousel, non-newRelease buttons
      if (!inCarousel && !isNewRelease) {
        ensureHoverStyle();
        // Also bind a JS-driven hover listener on the card root so
        // `data-ymd-hover-active` toggles regardless of how deeply
        // the cover element is nested. The pure CSS rule
        // `*:hover > marker` would only catch a fixed parent chain
        // depth, which breaks whenever Yandex tweaks card markup.
        if (card instanceof HTMLElement) {
          bindCardHover(card);
        }
      }
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Starts the Cover_Hover_Button and Carousel_Card_Button injector.
 *
 * Lifecycle: MutationObserver(document.body, {childList:true, subtree:true})
 * with 200 ms debounce + setInterval(scan, 2000) + URLObserver + 150-per-15s cap.
 */
export function startCoverButtonInjector(
  options: CoverButtonInjectorOptions,
): CoverButtonInjectorHandle {
  const { notify } = options;

  let stopped = false;
  let debounceHandle = 0;
  let intervalHandle = 0;

  // Re-evaluation cap state
  let evalCount = 0;
  let evalWindowStart = Date.now();

  function resetEvalCap(): void {
    evalCount = 0;
    evalWindowStart = Date.now();
  }

  function canEvaluate(): boolean {
    const now = Date.now();
    if (now - evalWindowStart > REVAL_WINDOW_MS) {
      // Window expired, reset
      resetEvalCap();
      return true;
    }
    return evalCount < REVAL_CAP;
  }

  function doScan(): void {
    if (stopped) return;
    if (!canEvaluate()) return;
    evalCount++;
    try {
      scanCovers(notify);
    } catch (e) {
      console.error("[ymd][cover-injector] scan error:", e);
    }
  }

  function scheduleScan(): void {
    if (stopped) return;
    if (debounceHandle !== 0) return;
    debounceHandle = window.setTimeout(() => {
      debounceHandle = 0;
      doScan();
    }, DEBOUNCE_MS);
  }

  // Initial scan
  doScan();

  // MutationObserver
  const observer = new MutationObserver(() => {
    scheduleScan();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Safety-net interval
  intervalHandle = window.setInterval(() => {
    doScan();
  }, SAFETY_NET_MS);

  // URLObserver — reset cap and scan on navigation
  observeURLChanges(() => {
    resetEvalCap();
    scheduleScan();
  });

  return {
    stop() {
      stopped = true;
      observer.disconnect();
      if (intervalHandle !== 0) {
        window.clearInterval(intervalHandle);
        intervalHandle = 0;
      }
      if (debounceHandle !== 0) {
        window.clearTimeout(debounceHandle);
        debounceHandle = 0;
      }
    },
  };
}
