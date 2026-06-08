/**
 * YouTube Download Button Injector
 *
 * Injects a download button into:
 *   - the watch-page action bar (regular `/watch?v=...` videos), or
 *   - the Shorts overlay actions sidebar (`/shorts/<id>`).
 *
 * Progress is rendered via the shared `src/content/progress-ring.ts`
 * helper — same SVG ring used by Yandex Music and VK, but with a YouTube
 * red accent (`#ff0000`) passed through `startProgressRing(btn, { accent })`.
 * The button's external surface — `setProgress`, `setState`, `setLabel`,
 * `setTooltip`, `remove` — is unchanged so the click flow in
 * `yt-content.ts` keeps compiling and behaving identically.
 *
 * Real byte-level / buffer-fill progress is funneled through
 * `setProgressRingPct(btn, pct)`, which the helper treats as a floor
 * over its pseudo-curve so the ring never moves backward.
 */

import {
  startProgressRing,
  clearProgressRing,
  setProgressRingPct,
  type ProgressRingHandle,
} from "../content/progress-ring";

export interface YtDownloadButton {
  setProgress(percent: number): void;
  setState(state: "idle" | "loading" | "success" | "error" | "disabled"): void;
  setTooltip(text: string): void;
  setLabel(text: string): void;
  remove(): void;
}

const INJECTED_ATTR = "data-ymus-yt-dl";
const LABEL_CLASS = "ymus-yt-dl-label";
const DOWNLOAD_ICON = `<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 0 24 24" fill="currentColor" style="flex-shrink:0"><path d="M5 20h14v-2H5v2zm7-18v12.17l3.59-3.58L17 12l-5 5-5-5 1.41-1.41L11 14.17V2h2z"/></svg>`;
/** Green check SVG — shown on `setState("success")`. Mirrors the
 *  Yandex Music track-row-injector pattern: a stand-alone glyph that
 *  reads cleanly without an accompanying label. The `currentColor`
 *  fill cooperates with the `data-state="success"` CSS rule which
 *  drives the wrapper into the brand green. */
const SUCCESS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>`;
/** Red error SVG — shown on `setState("error")`. Same `currentColor`
 *  handshake; the `data-state="error"` CSS rule paints it red. */
const ERROR_ICON = `<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
/** Slashed-circle SVG — shown on `setState("disabled")` to signal an
 *  unsupported / non-retryable failure (DRM, live, no quality). Same
 *  red palette via the `data-state="disabled"` CSS rule. */
const DISABLED_ICON = `<svg xmlns="http://www.w3.org/2000/svg" height="24" width="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`;
/** YouTube brand red — passed to the shared progress-ring helper so the
 *  YouTube buttons render a red accent without forking the helper. */
const YT_ACCENT = "#ff0000";
/** Brand green for the success state — matches the Yandex Music track
 *  button (`#34c759` light, `#4bb34b` dark) so the visual language is
 *  consistent across services. */
const SUCCESS_GREEN_LIGHT = "#1a8a1a";
const SUCCESS_GREEN_DARK = "#4bb34b";
/** Red palette for error + disabled — same red as Yandex Music's
 *  error track button (`#ff453a`-adjacent), with a softer dark-mode
 *  variant for contrast. */
const ERROR_RED_LIGHT = "#c00";
const ERROR_RED_DARK = "#e64646";

const MAX_TOOLTIP_LENGTH = 200;

/** Track injected buttons by videoId to prevent duplicates */
const injectedButtons = new Map<string, YtDownloadButton>();

let stylesInjected = false;

function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement("style");
  style.id = "ymus-yt-styles";
  style.textContent = `
    .ymus-yt-dl-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: var(--yt-spec-badge-chip-background, rgba(0,0,0,0.05));
      border: none;
      color: var(--yt-spec-text-primary, #0f0f0f);
      cursor: pointer;
      padding: 0 16px;
      height: 36px;
      font-size: 14px;
      font-weight: 500;
      font-family: "Roboto", "Arial", sans-serif;
      border-radius: 18px;
      white-space: nowrap;
      transition: background-color 0.2s;
      position: relative;
      overflow: hidden;
    }
    .ymus-yt-dl-btn:hover {
      background: var(--yt-spec-10-percent-layer, rgba(0,0,0,0.1));
    }
    html[dark] .ymus-yt-dl-btn {
      background: rgba(255,255,255,0.1);
      color: var(--yt-spec-text-primary, #f1f1f1);
    }
    html[dark] .ymus-yt-dl-btn:hover {
      background: rgba(255,255,255,0.2);
    }
    .ymus-yt-dl-btn[data-state="disabled"] {
      opacity: 0.5;
      cursor: default;
      pointer-events: none;
      color: ${ERROR_RED_LIGHT};
    }
    html[dark] .ymus-yt-dl-btn[data-state="disabled"] {
      color: ${ERROR_RED_DARK};
    }
    .ymus-yt-dl-btn[data-state="loading"] {
      color: ${YT_ACCENT};
    }
    html[dark] .ymus-yt-dl-btn[data-state="loading"] {
      color: ${YT_ACCENT};
    }
    .ymus-yt-dl-btn[data-state="success"] {
      color: ${SUCCESS_GREEN_LIGHT};
    }
    html[dark] .ymus-yt-dl-btn[data-state="success"] {
      color: ${SUCCESS_GREEN_DARK};
    }
    .ymus-yt-dl-btn[data-state="error"] {
      color: ${ERROR_RED_LIGHT};
    }
    html[dark] .ymus-yt-dl-btn[data-state="error"] {
      color: ${ERROR_RED_DARK};
    }

    /* Shorts sidebar button */
    .ymus-yt-dl-btn-shorts {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      background: transparent;
      border: none;
      color: #fff;
      cursor: pointer;
      padding: 12px 0;
      font-size: 12px;
      font-family: inherit;
      opacity: 0.9;
      transition: opacity 0.2s;
      width: 100%;
      position: relative;
    }
    .ymus-yt-dl-btn-shorts:hover {
      opacity: 1;
    }
    .ymus-yt-dl-btn-shorts[data-state="disabled"] {
      opacity: 0.5;
      cursor: default;
      pointer-events: none;
      color: ${ERROR_RED_DARK};
    }
    .ymus-yt-dl-btn-shorts[data-state="loading"] {
      color: ${YT_ACCENT};
    }
    .ymus-yt-dl-btn-shorts[data-state="success"] {
      color: ${SUCCESS_GREEN_DARK};
    }
    .ymus-yt-dl-btn-shorts[data-state="error"] {
      color: ${ERROR_RED_DARK};
    }
  `;
  document.head.appendChild(style);
}

function truncateTooltip(text: string): string {
  if (text.length <= MAX_TOOLTIP_LENGTH) return text;
  return text.slice(0, MAX_TOOLTIP_LENGTH);
}

/**
 * Update only the label text inside the button without disturbing the
 * progress-ring SVG / percent-text overlay siblings appended by
 * `startProgressRing`. We always write into a stable `<span class="ymus-yt-dl-label">`
 * element so `setLabel` calls during a loading cycle don't wipe the ring.
 */
function setLabelText(btn: HTMLElement, text: string): void {
  let label = btn.querySelector<HTMLSpanElement>(`.${LABEL_CLASS}`);
  if (label === null) {
    label = document.createElement("span");
    label.className = LABEL_CLASS;
    btn.appendChild(label);
  }
  label.textContent = text;
}

/**
 * Replace the button's leading icon + label with the default download
 * affordance. Used on `setState("idle")` to recover from any prior
 * label / state changes while keeping the ring overlay siblings
 * (cleared separately via `clearProgressRing`) safely removable.
 */
function renderIdleContent(btn: HTMLElement, isShorts: boolean): void {
  // Wipe everything (including any leftover ring SVG / pct text) — the
  // caller is responsible for calling `clearProgressRing` first which
  // removes those siblings cleanly. We re-render the icon + label.
  btn.replaceChildren();
  if (!isShorts) {
    // Inject the download SVG followed by the label span. innerHTML on
    // a fresh empty button is safe — there are no overlay siblings yet.
    btn.innerHTML = `${DOWNLOAD_ICON}<span class="${LABEL_CLASS}">Скачать</span>`;
  } else {
    // Shorts uses a single chevron glyph — no separate icon SVG.
    const span = document.createElement("span");
    span.className = LABEL_CLASS;
    span.textContent = "⬇";
    btn.appendChild(span);
  }
}

/**
 * Инжектирует кнопку скачивания в controls area видеоплеера.
 * Для Regular Video — в `.ytp-right-controls`.
 * Для Shorts — в боковую панель actions.
 *
 * Prevents duplicate injection for the same videoId.
 */
export function injectDownloadButton(
  videoId: string,
  videoType: "regular" | "shorts",
  onClick: () => void,
): YtDownloadButton | null {
  // Prevent duplicate injection for same video ID
  if (injectedButtons.has(videoId)) {
    return null;
  }

  injectStyles();

  let btn: HTMLButtonElement;
  let container: Element | null;
  const isShorts = videoType === "shorts";

  if (!isShorts) {
    // Insert into the action bar between "Сохранить" and "..." buttons
    // The action bar is inside ytd-menu-renderer.ytd-watch-metadata
    // We target #flexible-item-buttons or fall back to the top-level-buttons area
    const flexContainer = document.querySelector(
      "ytd-menu-renderer.ytd-watch-metadata #flexible-item-buttons"
    );
    const topLevelContainer = document.querySelector(
      "ytd-menu-renderer.ytd-watch-metadata #top-level-buttons-computed"
    );
    container = flexContainer || topLevelContainer;

    if (!container) {
      // Fallback: try the older layout selector
      container = document.querySelector("#menu-container ytd-menu-renderer");
    }
    if (!container) return null;

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ymus-yt-dl-btn";
    btn.setAttribute("aria-label", "Скачать видео");
    btn.setAttribute(INJECTED_ATTR, videoId);
    btn.setAttribute("data-state", "idle");
    btn.innerHTML = `${DOWNLOAD_ICON}<span class="${LABEL_CLASS}">Скачать</span>`;
    btn.title = "Скачать видео";

    // Insert before the "..." (Ещё) button — which is the last child,
    // or before the menu button element
    const menuButton = container.parentElement?.querySelector(
      ":scope > yt-button-shape#button, :scope > yt-icon-button#button"
    );
    if (menuButton) {
      container.parentElement!.insertBefore(btn, menuButton);
    } else {
      // Append at the end of the flex container
      container.appendChild(btn);
    }
  } else {
    // Shorts: inject into the actions sidebar
    container =
      document.querySelector("#actions.ytd-reel-player-overlay-renderer") ||
      document.querySelector("ytd-reel-player-overlay-renderer #actions") ||
      document.querySelector("#shorts-player .overlay #actions") ||
      document.querySelector("[id='actions']");
    if (!container) return null;

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ymus-yt-dl-btn-shorts";
    btn.setAttribute("aria-label", "Скачать видео");
    btn.setAttribute(INJECTED_ATTR, videoId);
    btn.setAttribute("data-state", "idle");
    btn.innerHTML = `<span class="${LABEL_CLASS}">⬇</span>`;
    btn.title = "Скачать видео";

    container.appendChild(btn);
  }

  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const state = btn.getAttribute("data-state");
    if (state === "disabled" || state === "loading") return;

    onClick();
  });

  /** Active progress-ring handle while the button is in `loading` state.
   *  Stored locally per-button so we can call `complete()` on success and
   *  `abort()` on error/idle/disabled transitions. The shared helper also
   *  tracks handles in its own WeakMap, so `setProgressRingPct` keeps
   *  working even if we never hand-rolled the cache. */
  let ringHandle: ProgressRingHandle | null = null;

  const stopRing = (mode: "abort" | "complete"): void => {
    if (ringHandle === null) return;
    if (mode === "complete") ringHandle.complete();
    else ringHandle.abort();
    ringHandle = null;
  };

  const handle: YtDownloadButton = {
    setProgress(percent: number): void {
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      // Drive the shared ring helper. Real byte-level / buffer-fill
      // progress acts as a floor — the helper's pseudo-curve smooths the
      // visual fill underneath but never moves backward.
      setProgressRingPct(btn, clamped);
    },

    setState(state: "idle" | "loading" | "success" | "error" | "disabled"): void {
      btn.setAttribute("data-state", state);
      switch (state) {
        case "idle":
          stopRing("abort");
          clearProgressRing(btn);
          renderIdleContent(btn, isShorts);
          break;
        case "loading":
          // Idempotent: if already loading, abort the previous handle so
          // the ring restarts at 0%. Otherwise this is a fresh start.
          if (ringHandle !== null) {
            ringHandle.abort();
            ringHandle = null;
          }
          ringHandle = startProgressRing(btn, { accent: YT_ACCENT });
          // Keep current label content; the ring overlay hides any
          // non-pct sibling spans via its CSS while loading.
          break;
        case "success":
          // Snap to 100, then strip the ring and show a green check.
          // The check sits in a `<span class="ymus-yt-dl-label">` so
          // `data-state="success"` CSS turns its `currentColor` green.
          // For watch we keep the icon next to the original label-style
          // glyph; for shorts we render only the icon (column layout).
          stopRing("complete");
          clearProgressRing(btn);
          btn.replaceChildren();
          if (!isShorts) {
            btn.innerHTML = `${SUCCESS_ICON}<span class="${LABEL_CLASS}">Готово</span>`;
          } else {
            btn.innerHTML = `<span class="${LABEL_CLASS}">${SUCCESS_ICON}</span>`;
          }
          break;
        case "error":
          // Red error glyph + short label. The `data-state="error"`
          // CSS rule paints the SVG `currentColor` stroke red.
          stopRing("abort");
          clearProgressRing(btn);
          btn.replaceChildren();
          if (!isShorts) {
            btn.innerHTML = `${ERROR_ICON}<span class="${LABEL_CLASS}">Ошибка</span>`;
          } else {
            btn.innerHTML = `<span class="${LABEL_CLASS}">${ERROR_ICON}</span>`;
          }
          break;
        case "disabled":
          // Slashed-circle glyph for "unavailable" (DRM, live, etc.).
          // Same red palette as `error` to communicate "won't retry".
          stopRing("abort");
          clearProgressRing(btn);
          btn.replaceChildren();
          if (!isShorts) {
            btn.innerHTML = `${DISABLED_ICON}<span class="${LABEL_CLASS}">Недоступно</span>`;
          } else {
            btn.innerHTML = `<span class="${LABEL_CLASS}">${DISABLED_ICON}</span>`;
          }
          break;
      }
    },

    setTooltip(text: string): void {
      btn.title = truncateTooltip(text);
    },

    setLabel(text: string): void {
      // Update only the dedicated label span so the ring SVG / percent
      // text overlay siblings appended by `startProgressRing` survive.
      setLabelText(btn, text);
    },

    remove(): void {
      stopRing("abort");
      clearProgressRing(btn);
      injectedButtons.delete(videoId);
      btn.remove();
    },
  };

  injectedButtons.set(videoId, handle);
  return handle;
}
