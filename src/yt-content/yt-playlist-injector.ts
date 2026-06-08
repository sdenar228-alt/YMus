/**
 * YouTube Playlist Download Button Injector.
 *
 * Adds a "Скачать плейлист" button into the playlist panel header (next to
 * the repeat / shuffle buttons). Clicking it kicks off a sequential download
 * of every video in the playlist:
 *   1. Read the list of videoIds from the rendered playlist DOM.
 *   2. Persist a marker ({ videoId, playlist: { listId, videoIds, index } })
 *      via chrome.storage and reload to /watch?v=<first>&list=<id>&index=1.
 *   3. After reload, the content-script bootstrap reads the marker, runs the
 *      regular download flow for that video, then advances index, persists
 *      the next marker, and reloads again. Repeat until the list runs out.
 *
 * Progress is rendered via the shared `src/content/progress-ring.ts`
 * helper — same SVG ring used by the per-video YouTube button — with a
 * red brand accent passed through `startProgressRing(btn, { accent })`.
 * The counter chip ("4/18") lives in a separate `<span>` overlay so it
 * doesn't interfere with the ring SVG; it sits below the button and
 * shows the current/total video position.
 *
 * This module ONLY handles button injection + collecting videoIds. The
 * chained-download mechanics live in yt-content.ts (see PendingDownload).
 */

import {
  startProgressRing,
  clearProgressRing,
  setProgressRingPct,
  type ProgressRingHandle,
} from "../content/progress-ring";

const TAG = "[YMus YT Playlist]";

/** Attribute marker so we don't inject twice into the same panel instance. */
const INJECTED_ATTR = "data-ymus-yt-pl-dl";

/** Inline SVG used inside the button. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zm7-18v12.17l3.59-3.58L17 12l-5 5-5-5 1.41-1.41L11 14.17V2h2z"/></svg>`;

/** YouTube brand red — passed to the shared progress-ring helper so the
 *  playlist button matches the per-video YouTube button accent. */
const YT_ACCENT = "#ff0000";

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "ymus-yt-playlist-styles";
  style.textContent = `
    .ymus-yt-pl-dl-btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 8px;
      margin: 0 2px;
      border-radius: 50%;
      width: 36px;
      height: 36px;
      transition: background-color 0.15s;
      flex-shrink: 0;
    }
    .ymus-yt-pl-dl-btn:hover {
      background: rgba(255,255,255,0.1);
    }
    html:not([dark]) .ymus-yt-pl-dl-btn:hover {
      background: rgba(0,0,0,0.06);
    }
    /* Counter chip — small "4/18" badge below the ring while downloading.
     * Lives in a separate <span> appended to the button so the SVG ring
     * overlay (managed by progress-ring.ts) doesn't compete for layout. */
    .ymus-yt-pl-dl-counter {
      position: absolute;
      top: calc(100% + 2px);
      left: 50%;
      transform: translateX(-50%);
      font-size: 10px;
      font-weight: 600;
      color: ${YT_ACCENT};
      white-space: nowrap;
      pointer-events: none;
      background: rgba(0, 0, 0, 0.7);
      padding: 1px 5px;
      border-radius: 6px;
      line-height: 1.2;
      display: none;
      z-index: 3;
    }
    html:not([dark]) .ymus-yt-pl-dl-counter {
      background: rgba(255, 255, 255, 0.95);
      color: ${YT_ACCENT};
      box-shadow: 0 1px 3px rgba(0,0,0,0.15);
    }
    .ymus-yt-pl-dl-btn[data-state="loading"] .ymus-yt-pl-dl-counter {
      display: block;
    }
    .ymus-yt-pl-dl-btn[data-state="loading"] {
      color: ${YT_ACCENT};
    }
    /* When loading, the icon gently pulses instead of the old continuous
     * spin — the SVG ring already conveys progress, so the icon doesn't
     * need to compete for attention. */
    .ymus-yt-pl-dl-btn[data-state="loading"] svg:not(.ymd-ring-svg) {
      animation: ymus-yt-pl-pulse 1.6s ease-in-out infinite;
    }
    @keyframes ymus-yt-pl-pulse {
      0%, 100% { opacity: 0.85; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.08); }
    }
    .ymus-yt-pl-dl-btn[data-state="disabled"] {
      opacity: 0.4;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Collects all videoIds from the currently rendered playlist panel.
 *
 * YouTube renders playlist entries as <ytd-playlist-panel-video-renderer>
 * inside <ytd-playlist-panel-renderer>. Each renderer carries a
 * <a id="wc-endpoint" href="/watch?v=XYZ&list=...&index=N"> link.
 *
 * We dedupe in case YouTube renders the same item in both the visible list
 * and a "next up" footer.
 */
export function collectPlaylistVideoIds(): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const items = document.querySelectorAll(
    "ytd-playlist-panel-renderer ytd-playlist-panel-video-renderer a#wc-endpoint",
  );
  for (const a of Array.from(items)) {
    const href = (a as HTMLAnchorElement).getAttribute("href");
    if (!href) continue;
    try {
      const url = new URL(href, location.origin);
      const v = url.searchParams.get("v");
      if (v && !seen.has(v)) {
        seen.add(v);
        ids.push(v);
      }
    } catch { /* ignore malformed href */ }
  }
  return ids;
}

/**
 * Reads the current playlist id from the URL.
 * Returns null if we're not on a playlist page.
 */
export function getCurrentPlaylistId(): string | null {
  try {
    const params = new URLSearchParams(location.search);
    const list = params.get("list");
    return list && list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

export interface PlaylistDownloadButton {
  setState(state: "idle" | "loading" | "disabled"): void;
  /**
   * Update the visual ring + counter while a chained playlist download is
   * running. `current` is the 1-based index of the video currently being
   * worked on; `total` is the playlist length. `pct` is optional and lets
   * the ring also reflect progress within the current video.
   */
  setProgress(current: number, total: number, pct?: number): void;
  remove(): void;
}

/**
 * Inject the "Скачать плейлист" button into the playlist panel header.
 * Returns the button handle, or null if no suitable container is found
 * (e.g. user navigated away from a playlist).
 *
 * Re-injects automatically if the playlist panel re-renders (idempotent
 * via INJECTED_ATTR check).
 */
export function injectPlaylistDownloadButton(
  onClick: () => void,
): PlaylistDownloadButton | null {
  injectStyles();

  // The "More actions" menu (•••) and the repeat/shuffle buttons sit in the
  // header of <ytd-playlist-panel-renderer>. Across YouTube's layouts the
  // header has been:
  //   ytd-playlist-panel-renderer #header
  //   ytd-playlist-panel-renderer #playlist-action-menu
  //   ytd-playlist-panel-renderer .header-action-buttons
  // We try them in priority order, then fall back to inserting just before
  // the menu button.
  const candidates = [
    "ytd-playlist-panel-renderer .header-action-buttons",
    "ytd-playlist-panel-renderer #playlist-actions",
    "ytd-playlist-panel-renderer #header .top-row-buttons",
    "ytd-playlist-panel-renderer ytd-menu-renderer",
  ];

  let container: Element | null = null;
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) {
      container = el;
      break;
    }
  }

  if (!container) {
    // Nothing matched — caller will retry on next mutation.
    return null;
  }

  // Already injected for this panel?
  const existing = container.parentElement?.querySelector(`button[${INJECTED_ATTR}]`);
  if (existing) {
    return null;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ymus-yt-pl-dl-btn";
  btn.setAttribute("aria-label", "Скачать плейлист");
  btn.setAttribute("title", "Скачать весь плейлист");
  btn.setAttribute(INJECTED_ATTR, "1");
  btn.setAttribute("data-state", "idle");
  btn.innerHTML = ICON;

  // Counter span is appended to the button so it can be positioned via the
  // same parent transform as the ring. Hidden by default; shown when state
  // becomes "loading". Lives outside the SVG ring overlay so the shared
  // progress-ring helper's `clearProgressRing` doesn't strip it.
  const counter = document.createElement("span");
  counter.className = "ymus-yt-pl-dl-counter";
  btn.appendChild(counter);

  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const state = btn.getAttribute("data-state");
    if (state === "loading" || state === "disabled") return;
    onClick();
  });

  // Prefer inserting BEFORE the existing menu button so our icon sits with
  // the rest of the header actions instead of after the kebab.
  if (container.matches("ytd-menu-renderer")) {
    container.parentElement?.insertBefore(btn, container);
  } else {
    container.appendChild(btn);
  }

  console.log(`${TAG} button injected`);

  /** Active progress-ring handle while the button is in `loading` state.
   *  Stored locally per-button so we can call `complete()` on success and
   *  `abort()` on transitions to `idle` / `disabled`. The shared helper
   *  also tracks handles in its own WeakMap, so `setProgressRingPct`
   *  keeps working through the cache. */
  let ringHandle: ProgressRingHandle | null = null;

  const stopRing = (mode: "abort" | "complete"): void => {
    if (ringHandle === null) return;
    if (mode === "complete") ringHandle.complete();
    else ringHandle.abort();
    ringHandle = null;
  };

  return {
    setState(state) {
      btn.setAttribute("data-state", state);
      if (state === "loading") {
        // Idempotent: if a previous loading cycle is still active, abort
        // it so the ring restarts at 0%. Otherwise this is a fresh start.
        if (ringHandle !== null) {
          ringHandle.abort();
          ringHandle = null;
        }
        ringHandle = startProgressRing(btn, { accent: YT_ACCENT });
      } else if (state === "idle") {
        // Tear down ring + counter so the button returns to plain icon.
        stopRing("abort");
        clearProgressRing(btn);
        counter.textContent = "";
      } else {
        // disabled — tear down ring/counter, keep button visible but inert.
        stopRing("abort");
        clearProgressRing(btn);
        counter.textContent = "";
      }
    },
    setProgress(current, total, pct) {
      // Ring fill: blend playlist-level progress with intra-video progress.
      // E.g. video 12 of 70 at 50% → overall ≈ ((12 - 1) + 0.5) / 70 ≈ 16%.
      const playlistShare = total > 0 ? (current - 1) / total : 0;
      const videoShare =
        typeof pct === "number" && total > 0 ? Math.max(0, Math.min(100, pct)) / 100 / total : 0;
      const overall = Math.min(100, Math.max(0, (playlistShare + videoShare) * 100));
      // Drive the shared ring helper. Real progress acts as a floor —
      // the helper's pseudo-curve smooths the visual fill underneath but
      // never moves backward.
      setProgressRingPct(btn, overall);
      // Counter chip shows the current/total position. Format matches
      // the legacy "4/18" pattern; the percent label inside the ring
      // (rendered by progress-ring.ts) covers the percentage side.
      counter.textContent = `${current}/${total}`;
    },
    remove() {
      stopRing("abort");
      clearProgressRing(btn);
      try { btn.remove(); } catch { /* ignore */ }
    },
  };
}
