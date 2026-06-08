// Инжектор кнопки скачивания в now-playing bar открытого
// Spotify-плеера (`https://open.spotify.com/*`).
//
// Контракт модуля:
//   * `startSpotifyNowPlayingInjector(onClick)` — единая точка запуска.
//     Находит now-playing bar по селекторам `[data-testid="now-playing-widget"]`
//     и его эквивалентам, инжектирует РОВНО ОДНУ кнопку (R2.9).
//   * При клике резолвит `SpotifyTrackMeta`:
//       1. ищет trackId внутри bar — современный Spotify не даёт прямой
//          ссылки `/track/{id}` в bar'е, поэтому мы перебираем все
//          возможные источники: `<a href="/album/.../track/{id}">`,
//          `data-context-uri="spotify:track:{id}"`, и (если ничего нет)
//          fallback на текущую `Spotify_Track_Row` на странице с
//          совпадающим title;
//       2. если на странице есть row с тем же trackId — мета оттуда
//          (полный набор: artist + album), иначе из самого bar (R3.4/R3.5).

import type { SpotifyTrackMeta } from "../shared/spotify-types";
import {
  createSpotifyDownloadButton,
  injectSpotifyButtonStyles,
  setButtonError,
} from "./spotify-button-states";
import {
  extractSpotifyTrackMeta,
  findSpotifyTrackIdInSubtree,
  isValidSpotifyTrackId,
} from "./spotify-track-meta";
import { showSpotifyError } from "./spotify-error-toast";

const NOW_PLAYING_BTN_CLASS = "ymus-spotify-now-playing-btn";
const NOW_PLAYING_STYLE_ID = "ymus-spotify-now-playing-styles";
const ENSURE_DEBOUNCE_MS = 150;

const NOW_PLAYING_SELECTORS: readonly string[] = [
  '[data-testid="now-playing-widget"]',
  '[data-testid="now-playing-bar"]',
  'footer[data-testid^="now-playing"]',
];

let onClickRef:
  | ((meta: SpotifyTrackMeta, btn: HTMLButtonElement) => void)
  | null = null;
let bodyObserver: MutationObserver | null = null;
let ensureScheduled = false;

export function startSpotifyNowPlayingInjector(
  onClick: (meta: SpotifyTrackMeta, btn: HTMLButtonElement) => void,
): void {
  onClickRef = onClick;
  injectSpotifyButtonStyles();
  injectNowPlayingStyles();
  ensureSingleButton();

  if (bodyObserver !== null) bodyObserver.disconnect();
  bodyObserver = new MutationObserver(() => scheduleEnsure());
  bodyObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-label", "data-testid"],
  });

  setTimeout(ensureSingleButton, 1000);
  setTimeout(ensureSingleButton, 3000);
}

export function stopSpotifyNowPlayingInjector(): void {
  if (bodyObserver !== null) {
    bodyObserver.disconnect();
    bodyObserver = null;
  }
  onClickRef = null;
}

function scheduleEnsure(): void {
  if (ensureScheduled) return;
  ensureScheduled = true;
  setTimeout(() => {
    ensureScheduled = false;
    ensureSingleButton();
  }, ENSURE_DEBOUNCE_MS);
}

function findNowPlayingBar(): HTMLElement | null {
  for (const selector of NOW_PLAYING_SELECTORS) {
    let el: HTMLElement | null;
    try {
      el = document.querySelector<HTMLElement>(selector);
    } catch {
      continue;
    }
    if (el !== null) return el;
  }
  return null;
}

function ensureSingleButton(): void {
  const bar = findNowPlayingBar();
  if (bar === null) return;

  const buttons = bar.querySelectorAll<HTMLButtonElement>(
    `.${NOW_PLAYING_BTN_CLASS}`,
  );
  if (buttons.length > 1) {
    for (let i = 1; i < buttons.length; i++) {
      try {
        buttons[i].remove();
      } catch {
        /* noop */
      }
    }
  }

  const existing = bar.querySelector<HTMLButtonElement>(
    `.${NOW_PLAYING_BTN_CLASS}`,
  );
  if (existing !== null && existing.isConnected) return;

  const btn = createSpotifyDownloadButton();
  btn.classList.add(NOW_PLAYING_BTN_CLASS);
  attachClickHandler(btn);

  // Пытаемся встроить кнопку в реальный flex-контейнер рядом с кнопкой
  // "Сохранить в библиотеку" (heart) или эквивалентом. Это даёт
  // естественное расположение в том же кластере, что и нативные
  // контролы Spotify, без overlap'а с обложкой/контролами громкости.
  const inserted = tryInsertNearAction(bar, btn);
  if (!inserted) {
    // Fallback: absolute-позиционирование сверху bar'а в правом-нижнем
    // углу, заведомо не на обложке. На этот случай bar форсится
    // в position: relative.
    if (bar instanceof HTMLElement) {
      const computed = window.getComputedStyle(bar);
      if (computed.position === "static") {
        bar.style.position = "relative";
      }
    }
    btn.classList.add("ymus-spotify-now-playing-btn--floating");
    try {
      bar.appendChild(btn);
    } catch {
      /* следующая мутация ретриггерит ensureSingleButton */
    }
  }
}

/**
 * Пытается встроить кнопку рядом с одной из «action»-кнопок left-cluster'а
 * now-playing bar'а (heart / add-to-playlist / chevron-up). Возвращает
 * `true`, если кнопка была вставлена в реальный flex-контейнер; `false`,
 * если ничего подходящего не нашлось — тогда вызывающий код уйдёт в
 * fallback-режим (absolute-позиционирование).
 */
function tryInsertNearAction(
  bar: HTMLElement,
  btn: HTMLButtonElement,
): boolean {
  // Ищем существующие нативные action-кнопки Spotify по известным
  // testid (порядок — от самого стабильного к менее).
  const ACTION_SELECTORS = [
    'button[data-testid="add-button"]',
    'button[aria-label*="library" i]',
    'button[aria-label*="ибиблиоте" i]',
    'button[data-testid="control-button-npv"]',
  ];
  for (const sel of ACTION_SELECTORS) {
    const action = bar.querySelector<HTMLElement>(sel);
    if (action === null) continue;
    const parent = action.parentElement;
    if (parent === null) continue;
    try {
      parent.insertBefore(btn, action);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function attachClickHandler(btn: HTMLButtonElement): void {
  const swallow = (event: Event): void => {
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  btn.addEventListener("pointerdown", swallow, true);
  btn.addEventListener("mousedown", swallow, true);
  btn.addEventListener("touchstart", swallow, { capture: true, passive: true });

  btn.addEventListener(
    "click",
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (btn.classList.contains("ymus-loading")) return;

      const bar = findNowPlayingBar();
      if (bar === null) {
        showSpotifyError("SPOTIFY_TRACK_ID_INVALID");
        setButtonError(btn);
        return;
      }

      const meta = resolveMetaForBar(bar);
      if (meta === null) {
        try {
          const links = Array.from(bar.querySelectorAll<HTMLAnchorElement>("a"))
            .slice(0, 12)
            .map((a) => ({
              href: a.getAttribute("href"),
              text: (a.textContent ?? "").trim().slice(0, 40),
              testid: a.getAttribute("data-testid"),
            }));
          const uriHosts = Array.from(
            bar.querySelectorAll<HTMLElement>("[data-context-uri], [data-uri]"),
          ).map((el) => ({
            tag: el.tagName.toLowerCase(),
            testid: el.getAttribute("data-testid"),
            uri:
              el.getAttribute("data-context-uri") ??
              el.getAttribute("data-uri") ??
              "",
          }));
          const activeOnPage = document.querySelector<HTMLElement>(
            '[data-testid="tracklist-row"][aria-selected="true"], ' +
              '[data-testid="tracklist-row"][aria-current="true"], ' +
              '[data-testid="tracklist-row"][data-active="true"]',
          );
          console.warn(
            "[ymd][spotify][now-playing] resolveMetaForBar returned null.",
            {
              links,
              uriHosts,
              activeRowFound: activeOnPage !== null,
              barHtml: bar.outerHTML.slice(0, 1000),
            },
          );
        } catch {
          /* ignore diag failure */
        }
        showSpotifyError("SPOTIFY_TRACK_ID_INVALID");
        setButtonError(btn);
        return;
      }

      if (onClickRef !== null) onClickRef(meta, btn);
    },
    true,
  );
}

/**
 * Резолвит `SpotifyTrackMeta` для текущего now-playing bar.
 *
 * Spotify-Web-Player в актуальной разметке НЕ отдаёт прямую ссылку
 * на `/track/{id}` ни в баре, ни через `data-uri`. Единственный
 * стабильный источник — `aria-label="Сейчас играет: <title> (<artists>)"`
 * + ссылка на обложку `i.scdn.co/image/{40-hex}`.
 *
 * Стратегия резолвинга по приоритету:
 *   1. Прямой `findSpotifyTrackIdInSubtree(bar)` — на случай, если
 *      Spotify в будущем вернёт ссылку.
 *   2. `findCurrentlyPlayingTrackIdOnPage` — если активный row помечен
 *      `aria-current/aria-selected/data-active`.
 *   3. **Главный путь**: вытащить title из `aria-label` бара и найти
 *      соответствующий `Spotify_Track_Row` на странице по совпадению
 *      `textContent` ссылки `/track/{id}` (case-insensitive).
 *   4. Финальный fallback — `extractSpotifyTrackMeta(bar)`, который
 *      вернёт `null`, если в баре нет ни одного `/track/`.
 */
function resolveMetaForBar(bar: HTMLElement): SpotifyTrackMeta | null {
  // 1. Прямой поиск trackId в баре.
  let trackId = findSpotifyTrackIdInSubtree(bar);

  // 2. Активная row на странице (aria-current/selected/active).
  if (trackId === null) {
    trackId = findCurrentlyPlayingTrackIdOnPage();
  }

  // 3. По совпадению title из aria-label с любой видимой row на странице.
  if (trackId === null) {
    const fromTitle = findTrackIdByNowPlayingTitle(bar);
    if (fromTitle !== null) trackId = fromTitle;
  }

  if (trackId !== null) {
    // Нашли — попробуем подобрать row для богатых метаданных.
    const row = findRowOnPageByTrackId(trackId);
    if (row !== null) {
      const fromRow = extractSpotifyTrackMeta(row);
      if (fromRow !== null && fromRow.trackId === trackId) return fromRow;
    }
    // Row нет (например, играет трек из другой вкладки), но trackId известен.
    // Минимальная мета — title из aria-label.
    const fromAriaLabel = readAriaLabelMeta(bar);
    if (fromAriaLabel !== null) {
      return { ...fromAriaLabel, trackId, trackUri: `spotify:track:${trackId}` };
    }
  }

  // 4. Финальный fallback.
  return extractSpotifyTrackMeta(bar);
}

/**
 * Парсит `aria-label="Сейчас играет: <title> (<artist1>, <artist2>, …)"`
 * (или его английский аналог `Now playing: …`) и возвращает title +
 * artist. Возвращает `null`, если формат не распознан.
 */
function readAriaLabelMeta(
  bar: HTMLElement,
): { title: string; artist: string } | null {
  const label = bar.getAttribute("aria-label");
  if (label === null || label.length === 0) return null;
  // Префиксы "Сейчас играет:" / "Now playing:" / "Spelar nu:" и т.п. —
  // снимаем всё до первого ":", если оно есть и явно не часть title.
  const colonIdx = label.indexOf(":");
  const stripped = colonIdx > 0 && colonIdx < 30 ? label.slice(colonIdx + 1) : label;
  // Дальше формат "<title> (<artists>)". Ищем последнюю открывающую
  // скобку — внутри неё артисты.
  const trimmed = stripped.trim();
  const lastOpen = trimmed.lastIndexOf("(");
  if (lastOpen <= 0 || !trimmed.endsWith(")")) {
    return { title: trimmed, artist: "Unknown Artist" };
  }
  const title = trimmed.slice(0, lastOpen).trim();
  const artistList = trimmed
    .slice(lastOpen + 1, trimmed.length - 1)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const artist = artistList.length > 0 ? artistList.join(", ") : "Unknown Artist";
  return { title, artist };
}

/**
 * Извлекает title из `aria-label` бара и пытается найти на странице row,
 * у которой `<a href*="/track/">` имеет такой же `textContent` (без
 * учёта регистра и краевых пробелов). Возвращает trackId либо `null`.
 */
function findTrackIdByNowPlayingTitle(bar: HTMLElement): string | null {
  const meta = readAriaLabelMeta(bar);
  if (meta === null || meta.title.length === 0) return null;
  const needle = meta.title.toLowerCase();

  const rows = document.querySelectorAll<HTMLElement>(
    '[data-testid="tracklist-row"]',
  );
  for (const row of Array.from(rows)) {
    const trackLinks = row.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/track/"]',
    );
    for (const link of Array.from(trackLinks)) {
      const text = (link.textContent ?? "").trim().toLowerCase();
      if (text === needle) {
        const id = findSpotifyTrackIdInSubtree(row);
        if (id !== null && isValidSpotifyTrackId(id)) return id;
      }
    }
  }
  return null;
}

/**
 * Найти активный трек на странице — Spotify подсвечивает его зелёным
 * в трек-листе (атрибут `aria-current="true"` либо отдельный
 * `data-active="true"` на link'е). Возвращает trackId или `null`,
 * если ничего не подсвечено (например, играет трек из другой вкладки
 * или из плейлиста, не открытого пользователем).
 */
function findCurrentlyPlayingTrackIdOnPage(): string | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[data-testid="tracklist-row"][aria-selected="true"], ' +
      '[data-testid="tracklist-row"][aria-current="true"], ' +
      '[data-testid="tracklist-row"][data-active="true"]',
  );
  for (const row of Array.from(candidates)) {
    const id = findSpotifyTrackIdInSubtree(row);
    if (id !== null && isValidSpotifyTrackId(id)) return id;
  }
  return null;
}

function findRowOnPageByTrackId(trackId: string): Element | null {
  const rows = document.querySelectorAll<HTMLElement>(
    '[data-testid="tracklist-row"]',
  );
  const needle = `/track/${trackId}`;
  for (const row of Array.from(rows)) {
    // Проверяем все href с /track/, не только первый.
    const links = row.querySelectorAll<HTMLAnchorElement>(
      'a[href*="/track/"]',
    );
    for (const link of Array.from(links)) {
      const href = link.getAttribute("href") ?? "";
      if (href.includes(needle)) return row;
    }
  }
  return null;
}

/**
 * Стили now-playing-варианта кнопки. Кнопка — абсолют внутри bar'а,
 * чтобы она не сдвигала flex-layout оригинальных контролов и не
 * "висла" поверх обложки. Bar в `ensureSingleButton` форсится в
 * `position: relative`, чтобы наш absolute правильно позиционировался.
 */
function injectNowPlayingStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(NOW_PLAYING_STYLE_ID) !== null) return;

  const head = document.head ?? document.documentElement;
  if (head === null) return;

  const style = document.createElement("style");
  style.id = NOW_PLAYING_STYLE_ID;
  style.textContent = `
    .${NOW_PLAYING_BTN_CLASS} {
      width: 32px !important;
      height: 32px !important;
      min-width: 32px !important;
      display: inline-flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      flex-shrink: 0 !important;
    }
    /* Floating fallback — когда не нашли реальный action-кластер для
     * inline-вставки. Кнопка лежит абсолютом в правом-нижнем углу
     * bar'а; bar форсится в position: relative в ensureSingleButton. */
    .${NOW_PLAYING_BTN_CLASS}--floating {
      position: absolute !important;
      right: 16px !important;
      bottom: 12px !important;
      z-index: 100 !important;
    }
  `;
  head.appendChild(style);
}
