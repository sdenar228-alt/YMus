import type { VkTrackMeta } from "../shared/types";
import { extractVkTrackMeta } from "./vk-track-meta";
import { showVkError, VK_ERROR_CODES } from "./vk-error-toast";

const VK_BOUND_ATTR = "data-ymus-vk-bound";
const VK_PLAYER_BOUND_ATTR = "data-ymus-vk-player-bound";

const VK_AUDIO_SELECTORS: readonly string[] = [
  ".audio_row[data-full-id]",
  '[class*="AudioRow__root"][data-sortable-id]',
  '[class*="AudioRow__root"][data-testentitytag="audio"]',
];

const ICON_DOWNLOAD_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
const ICON_CHECK_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><polyline points="20 6 9 17 4 12"/></svg>`;

let onClickRef: ((meta: VkTrackMeta, btn: HTMLButtonElement) => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function createDownloadButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ymus-vk-dl-btn";
  btn.setAttribute("aria-label", "Скачать трек");
  btn.title = "Скачать";
  // Three slots stacked into the same center: idle download icon, success
  // check icon, loading percent text. Visibility is toggled by the state
  // class (.ymus-loading / .ymus-success) on the button so exactly one
  // child renders at a time.
  btn.innerHTML =
    `<span class="ymus-vk-dl-icon">${ICON_DOWNLOAD_SVG}</span>` +
    `<span class="ymus-vk-dl-check">${ICON_CHECK_SVG}</span>` +
    `<span class="ymus-vk-dl-pct">0%</span>`;
  return btn;
}

function createPlayerDownloadButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ymus-vk-dl-btn ymus-vk-player-dl-btn";
  btn.setAttribute("aria-label", "Скачать текущий трек");
  btn.title = "Скачать";
  btn.innerHTML =
    `<span class="ymus-vk-dl-icon">${ICON_DOWNLOAD_SVG}</span>` +
    `<span class="ymus-vk-dl-check">${ICON_CHECK_SVG}</span>` +
    `<span class="ymus-vk-dl-pct">0%</span>`;
  return btn;
}

/**
 * Update the visual progress (0-100) on a download button.
 * Sets the conic-gradient angle via --ymus-pct and updates the % label.
 * No-op if the button is not in the loading state (we don't fight other
 * states like success/error).
 */
export function setDownloadButtonProgress(btn: HTMLElement, percent: number): void {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  btn.style.setProperty("--ymus-pct", String(pct));
  const label = btn.querySelector<HTMLElement>(".ymus-vk-dl-pct");
  if (label) label.textContent = `${pct}%`;
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement("style");
  style.id = "ymus-vk-styles";
  style.textContent = `
    /* Download button — sits in a 30px slot OUTSIDE the row's left edge.
     * The row gets margin-left:30px, which shifts the row right and frees a
     * slot for our button via left:-30px (negative offset against the row's
     * own positioning context). This way the button is to the LEFT of the
     * cover, not on top of it. */
    .ymus-vk-dl-btn {
      width: 28px;
      height: 28px;
      min-width: 28px;
      padding: 0;
      margin: 0;
      background: transparent;
      color: #939fad;
      border: none;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: color 0.15s, background 0.15s;
      opacity: 1;
      position: absolute;
      left: -30px;
      top: 50%;
      margin-top: -14px;
      z-index: 100;
      pointer-events: auto;
      /* Progress fill rendered via conic-gradient driven by --ymus-pct.
       * Hidden by default (radius:0); switched on while loading. */
      --ymus-pct: 0;
    }
    .audio_row[data-ymus-vk-bound],
    [class*="AudioRow__root"][data-ymus-vk-bound] {
      position: relative !important;
      margin-left: 30px !important;
    }
    .ymus-vk-dl-btn:hover {
      color: #fff !important;
      background: rgba(255,255,255,0.1) !important;
    }
    /* The icon, the check and the text share the SAME center slot.
     * Stack them via absolute positioning and toggle visibility based on
     * the state class on the button. Using visibility (not display)
     * removes any chance of a cascade override leaking two children.
     * Default (no state class): icon visible. */
    .ymus-vk-dl-btn :is(.ymus-vk-dl-icon, .ymus-vk-dl-check, .ymus-vk-dl-pct) {
      position: absolute;
      inset: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      z-index: 1;
      visibility: hidden;
    }
    /* Idle (no state class): icon visible. */
    .ymus-vk-dl-btn .ymus-vk-dl-icon { visibility: visible; }
    /* Loading: percent visible, icon hidden. */
    .ymus-vk-dl-btn.ymus-loading .ymus-vk-dl-icon { visibility: hidden; }
    .ymus-vk-dl-btn.ymus-loading .ymus-vk-dl-pct { visibility: visible; }
    /* Success: check visible, icon hidden. */
    .ymus-vk-dl-btn.ymus-success .ymus-vk-dl-icon { visibility: hidden; }
    .ymus-vk-dl-btn.ymus-success .ymus-vk-dl-check { visibility: visible; }

    .ymus-vk-dl-pct {
      font-size: 9px;
      font-weight: 700;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1;
      letter-spacing: -0.3px;
      color: inherit;
    }
    /* Progress ring rendered via conic-gradient ::before. Hidden until
     * the button enters the loading state. The mask cuts a wide hole in
     * the middle so the ring is thin (≈2.5px) and the percent text
     * underneath reads cleanly. VK accent: blue. */
    .ymus-vk-dl-btn::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: 50%;
      pointer-events: none;
      background: conic-gradient(
        #71aaeb calc(var(--ymus-pct) * 1%),
        rgba(113, 170, 235, 0.18) calc(var(--ymus-pct) * 1%) 100%
      );
      mask: radial-gradient(circle, transparent 11px, #000 12px);
      -webkit-mask: radial-gradient(circle, transparent 11px, #000 12px);
      opacity: 0;
      transition: opacity 0.15s;
    }
    .ymus-vk-dl-btn.ymus-loading::before {
      opacity: 1;
    }
    /* Loading state — blue ring, blue percent text. NO rotation. */
    .ymus-vk-dl-btn.ymus-loading {
      opacity: 1 !important;
      color: #71aaeb !important;
      background: rgba(113, 170, 235, 0.08) !important;
    }
    /* Success state — green check icon. */
    .ymus-vk-dl-btn.ymus-success {
      opacity: 1 !important;
      color: #4bb34b !important;
      background: rgba(75, 179, 75, 0.12) !important;
    }
    /* Error state */
    .ymus-vk-dl-btn.ymus-error {
      opacity: 1 !important;
      color: #e64646 !important;
    }

    /* Player download button */
    .ymus-vk-player-dl-btn {
      opacity: 1 !important;
      position: relative !important;
      left: auto !important;
      top: auto !important;
      margin: 0 4px !important;
      margin-top: 0 !important;
      transform: none !important;
      width: 28px !important;
      height: 28px !important;
      min-width: 28px !important;
      max-width: 28px !important;
      display: flex !important;
      flex: 0 0 28px !important;
      visibility: visible !important;
      z-index: 2 !important;
    }
    .ymus-vk-player-dl-btn::before {
      mask: radial-gradient(circle, transparent 11px, #000 12px);
      -webkit-mask: radial-gradient(circle, transparent 11px, #000 12px);
    }

  `;
  document.head.appendChild(style);
}

function scanAndInject(): void {
  injectStyles();

  const seen = new Set<Element>();

  for (const selector of VK_AUDIO_SELECTORS) {
    let elements: NodeListOf<Element>;
    try {
      elements = document.querySelectorAll(selector);
    } catch {
      continue;
    }

    for (const audioEl of Array.from(elements)) {
      if (seen.has(audioEl)) continue;
      seen.add(audioEl);

      // Verify the button is still there even if marked bound. React on the main
      // "Музыка" page wipes our injected children on re-render, leaving the
      // attribute set with no working button.
      const existingBtn = audioEl.querySelector(":scope > button.ymus-vk-dl-btn") as HTMLButtonElement | null;
      if (audioEl.getAttribute(VK_BOUND_ATTR) !== null && existingBtn && existingBtn.isConnected) {
        continue;
      }
      if (existingBtn && !existingBtn.isConnected) {
        // Stale — let it fall through and re-inject
        audioEl.removeAttribute(VK_BOUND_ATTR);
      } else if (audioEl.getAttribute(VK_BOUND_ATTR) !== null && !existingBtn) {
        audioEl.removeAttribute(VK_BOUND_ATTR);
      }

      const btn = createDownloadButton();

      // Tag the button with a row-key so we can find it after React re-renders
      const rowKey = audioEl.getAttribute("data-full-id") ?? audioEl.getAttribute("data-sortable-id") ?? "";
      if (rowKey) btn.setAttribute("data-ymus-row-key", rowKey);

      // Block ALL pointer events that VK might use to trigger playback.
      // VK on vkit uses pointerdown (not just mousedown) so we suppress the
      // entire family in capture phase.
      const swallow = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      };
      btn.addEventListener("pointerdown", swallow, true);
      btn.addEventListener("mousedown", swallow, true);
      btn.addEventListener("touchstart", swallow, { capture: true, passive: false });

      btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();

        if (btn.classList.contains("ymus-loading")) return;

        // Re-resolve the row at click time. On vkit the original audioEl
        // may have been replaced by React; look it up by row-key first.
        let rowAtClick: Element | null = audioEl.isConnected ? audioEl : null;
        if (!rowAtClick) {
          const key = btn.getAttribute("data-ymus-row-key");
          if (key) {
            rowAtClick = document.querySelector(`[data-full-id="${cssEscape(key)}"], [data-sortable-id="${cssEscape(key)}"]`);
          }
        }
        if (!rowAtClick) rowAtClick = btn.closest('.audio_row[data-full-id], [class*="AudioRow__root"][data-sortable-id]');

        if (!rowAtClick) {
          showVkError(VK_ERROR_CODES.CLICK_ORPHANED_ROW, undefined, { btn });
          btn.classList.add("ymus-error");
          setTimeout(() => btn.classList.remove("ymus-error"), 1500);
          return;
        }

        // Try to extract meta from the row. If null, try descendants and
        // ancestors with data-full-id / data-sortable-id (vkit wraps content
        // in nested fragments that move the data-* attribute around).
        let meta = extractVkTrackMeta(rowAtClick);
        if (meta === null) {
          const candidates = [
            rowAtClick.closest("[data-full-id], [data-sortable-id]"),
            rowAtClick.querySelector("[data-full-id], [data-sortable-id]"),
          ].filter((c): c is Element => c !== null && c !== rowAtClick);
          for (const c of candidates) {
            const m = extractVkTrackMeta(c);
            if (m !== null) { meta = m; break; }
          }
        }

        // Last-resort: ask the page-bridge to walk the React fiber. Only
        // works on vkit pages, but those are exactly where data-* is
        // missing on third-party playlists.
        if (meta === null) {
          const fiberMeta = await extractMetaViaFiber(rowAtClick);
          if (fiberMeta !== null) meta = fiberMeta;
        }

        if (meta !== null && onClickRef !== null) {
          console.log("[YMus VK click] accepted", meta.ownerId + "_" + meta.audioId);
          onClickRef(meta, btn);
        } else {
          const code = onClickRef === null
            ? VK_ERROR_CODES.CLICK_REF_NULL
            : VK_ERROR_CODES.CLICK_META_NULL;
          showVkError(code, undefined, {
            metaIsNull: meta === null,
            refIsNull: onClickRef === null,
            dataFullId: rowAtClick.getAttribute("data-full-id"),
            dataSortableId: rowAtClick.getAttribute("data-sortable-id"),
            outerHTMLPrefix: (rowAtClick as HTMLElement).outerHTML?.slice(0, 200),
          });
          btn.classList.add("ymus-error");
          setTimeout(() => btn.classList.remove("ymus-error"), 1500);
        }
      }, true);

      // Append the button INSIDE the row (left-absolute via CSS). Then attach
      // a MutationObserver to the row that re-injects the button if React
      // wipes it during re-render. This is the fix for the "main Музыка" page.
      (audioEl as HTMLElement).appendChild(btn);
      audioEl.setAttribute(VK_BOUND_ATTR, "1");
      protectButtonFromReact(audioEl as HTMLElement, btn);
    }
  }

  injectPlayerButton();
}

/**
 * Watch the row for React re-renders that strip our button.
 * If the button leaves the row's children, re-attach it. Stops watching
 * when the row itself is detached.
 */
function protectButtonFromReact(row: HTMLElement, btn: HTMLButtonElement): void {
  let stopped = false;
  const obs = new MutationObserver(() => {
    if (stopped) return;
    if (!row.isConnected) {
      stopped = true;
      obs.disconnect();
      return;
    }
    // If our button is no longer a child of the row, re-attach.
    if (!row.contains(btn)) {
      try {
        row.appendChild(btn);
      } catch {
        // Row might be in a transient state; observer will fire again.
      }
    }
  });
  obs.observe(row, { childList: true });
}

/** Toast helper used inside the injector (info-only; errors go through showVkError). */
function showInjectedToast(message: string): void {
  const t = document.createElement("div");
  t.className = "ymus-vk-toast";
  t.textContent = message;
  t.style.cssText = `position:fixed;bottom:24px;right:24px;background:#1d1d1f;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.3);`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

/** Minimal CSS.escape polyfill. */
function cssEscape(value: string): string {
  if (typeof (window as any).CSS !== "undefined" && typeof (window as any).CSS.escape === "function") {
    return (window as any).CSS.escape(value);
  }
  return value.replace(/(["\\])/g, "\\$1");
}

/**
 * Ask the page-bridge (running in MAIN world) to walk the React fiber
 * starting at this DOM row and extract `memoizedProps.track.entity`.
 * Returns null if the row isn't React-managed or the fiber doesn't carry
 * track data. Used as last-resort fallback on third-party playlist rows
 * that don't expose data-full-id / data-sortable-id.
 */
async function extractMetaViaFiber(row: Element): Promise<VkTrackMeta | null> {
  return new Promise((resolve) => {
    const requestId = `ymus_fiber_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const MARK = "data-ymus-row-mark";

    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail?.requestId !== requestId) return;
      document.removeEventListener("ymus-extract-meta-result", handler);
      try { row.removeAttribute(MARK); } catch {}
      const m = detail.meta;
      if (m && typeof m.ownerId === "string" && typeof m.audioId === "string") {
        resolve({
          ownerId: m.ownerId,
          audioId: m.audioId,
          artist: m.artist || "Unknown",
          title: m.title || `audio_${m.audioId}`,
          encryptedUrl: m.encryptedUrl || undefined,
          accessKey: m.accessKey || undefined,
        });
      } else {
        resolve(null);
      }
    };
    document.addEventListener("ymus-extract-meta-result", handler);

    try {
      row.setAttribute(MARK, requestId);
      document.dispatchEvent(new CustomEvent("ymus-extract-meta-by-mark", { detail: { requestId } }));
    } catch {
      document.removeEventListener("ymus-extract-meta-result", handler);
      resolve(null);
      return;
    }

    setTimeout(() => {
      document.removeEventListener("ymus-extract-meta-result", handler);
      try { row.removeAttribute(MARK); } catch {}
      resolve(null);
    }, 1500);
  });
}

function injectPlayerButton(): void {
  // 1. Main AudioPlayerBlock (expanded player with cover and controls)
  const audioBlock = document.querySelector('.AudioPlayerBlock__root, [class*="AudioPlayerBlock__root"]') as HTMLElement | null;
  if (audioBlock) {
    const buttonsArea = audioBlock.querySelector('[class*="audioButtons"]') as HTMLElement | null;
    if (buttonsArea) {
      const existing = buttonsArea.querySelectorAll('.ymus-vk-player-dl-btn');
      if (existing.length > 1) {
        for (let i = 1; i < existing.length; i++) existing[i].remove();
      }
      if (existing.length === 0) {
        const btn = createPlayerDownloadButton();
        attachPlayerClickHandler(btn);
        buttonsArea.appendChild(btn);
      }
    }
  }

  // 2. Overlay PlaybackControls (only if NOT inside AudioPlayerBlock)
  const allControls = document.querySelectorAll('[class*="AudioPlayerPlaybackControls__root"]');
  for (const ctrl of Array.from(allControls)) {
    if (ctrl.closest('.AudioPlayerBlock__root, [class*="AudioPlayerBlock__root"]')) continue;
    if (!isTopPlayerElement(ctrl)) continue;
    const parent = ctrl.parentElement;
    if (!parent) continue;
    if (parent.querySelector('.ymus-vk-player-dl-btn')) continue;
    const btn = createPlayerDownloadButton();
    attachPlayerClickHandler(btn);
    parent.insertBefore(btn, ctrl.nextSibling);
  }
}

function isTopPlayerElement(el: Element): boolean {
  const rect = (el as HTMLElement).getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.top < 0 || rect.top > 90) return false;
  if (
    el.closest(
      [
        '[class*="AudioListBox"]',
        '[class*="Modal"]',
        '[class*="Popup"]',
        '[class*="Queue"]',
        '[class*="queue"]',
        '[class*="Dropdown"]',
      ].join(", "),
    )
  ) {
    return false;
  }
  return true;
}

function attachPlayerClickHandler(btn: HTMLButtonElement): void {
  btn.addEventListener("mousedown", (event) => {
    event.stopPropagation();
    event.stopImmediatePropagation();
  }, true);

  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (btn.classList.contains("ymus-loading")) return;

    console.log("[YMus VK player] click received, resolving current track");

    // Strategy 0: synchronous getCurrentAudio() via page-bridge
    // VK player API is synchronous; we ask the bridge but with a short race
    // (200ms) so we don't block on slow listeners. If the bridge doesn't
    // answer in time, fall through to DOM strategies.
    // We fire this immediately and let it race with DOM lookups below.
    const fastRequestId = `ymus_player_fast_${Date.now()}`;
    let fastResolved = false;
    const fastHandler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail?.requestId === fastRequestId && detail?.meta && !fastResolved) {
        fastResolved = true;
        document.removeEventListener("ymus-current-track-result", fastHandler);
        console.log("[YMus VK player] fast-path resolved via player API:", detail.meta.ownerId + "_" + detail.meta.audioId);
        if (onClickRef) onClickRef(detail.meta, btn);
      }
    };
    document.addEventListener("ymus-current-track-result", fastHandler);
    document.dispatchEvent(new CustomEvent("ymus-get-current-track", { detail: { requestId: fastRequestId } }));

    // Give the bridge a tiny window to win the race before DOM strategies
    setTimeout(() => {
      if (fastResolved) return;

      // Strategy 1: classic .audio_row_current
      let currentRow = document.querySelector(
        '.audio_row_current[data-full-id], .audio_row.audio_row_current[data-full-id]'
      );

      // Strategy 2: vkit currently playing row
      if (!currentRow) {
        currentRow = document.querySelector(
          '[class*="AudioRow__root"][class*="playing"][data-sortable-id]'
        ) || document.querySelector(
          '[class*="AudioRow__root"][aria-current="true"][data-sortable-id]'
        );
      }

      if (currentRow) {
        const meta = extractVkTrackMeta(currentRow);
        if (meta && onClickRef) {
          fastResolved = true;
          document.removeEventListener("ymus-current-track-result", fastHandler);
          console.log("[YMus VK player] resolved via DOM row:", meta.ownerId + "_" + meta.audioId);
          onClickRef(meta, btn);
          return;
        }
      }
    }, 50); // 50ms is enough for synchronous VK API; fast-path almost always wins

    // Final timeout: if neither fast-path nor DOM strategies resolved within
    // 1500ms, give up with an error toast. Previous code waited 5000ms which
    // is what users were hitting.
    setTimeout(() => {
      if (fastResolved) return;
      fastResolved = true;
      document.removeEventListener("ymus-current-track-result", fastHandler);
      showVkError(VK_ERROR_CODES.PLAYER_TIMEOUT);
      btn.classList.add("ymus-error");
      setTimeout(() => btn.classList.remove("ymus-error"), 2000);
    }, 1500);
  }, true);
}

function debouncedScan(): void {
  if (debounceTimer !== null) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    scanAndInject();
  }, 200);
}

export function startVkTrackInjector(
  onClick: (meta: VkTrackMeta, btn: HTMLButtonElement) => void,
): void {
  onClickRef = onClick;

  scanAndInject();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const removed of Array.from(mutation.removedNodes)) {
        if (!(removed instanceof Element)) continue;
        const boundElements = removed.querySelectorAll(`[${VK_BOUND_ATTR}]`);
        for (const el of Array.from(boundElements)) {
          el.removeAttribute(VK_BOUND_ATTR);
        }
      }
    }
    debouncedScan();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => scanAndInject(), 3000);
}
