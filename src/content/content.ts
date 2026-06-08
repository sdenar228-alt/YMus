// Content Script — UI на странице music.yandex.ru.
// Скачивание идёт прямо здесь (через background для resolve), с тегами.

import {
  ensureFloatingButton,
  startFloatingButtonGuard,
  type FloatingButton,
} from "./floating-button";
import {
  startTrackRowInjector,
  flashOverlayButton,
} from "./track-row-injector";
import { extractTrackMeta } from "./track-meta";
import { startYmBridgeListener } from "./ym-bridge-listener";
import { downloadTrackWithTags } from "./downloader";
import { setProgressRingPct } from "./progress-ring";
import {
  removeLegacyBulkArtifacts,
  startLegacyBulkSanitizer,
} from "./bulk-legacy-sanitizer";
import { startPlaylistHeaderButton } from "./playlist-header-button";
import { startSearchTrackInjector } from "./search-track-injector";
import { startCoverButtonInjector } from "./cover-button-injector";
import { startHistoryInjector } from "./history-injector";
import { startSidebarChartLink } from "./sidebar-chart-link";

let ui: FloatingButton | null = null;

interface MetaHint {
  artist?: string;
  title?: string;
}

function userMessageForError(reason?: string, errorCode?: string): string {
  if (errorCode === "AUTH_REQUIRED") return reason ?? "Auth required";
  if (errorCode === "PREVIEW_ONLY")
    return reason ?? "API вернул только превью";
  if (errorCode === "DRM_PROTECTED")
    return "Трек недоступен для скачивания (DRM)";
  if (errorCode === "NETWORK_ERROR") return "Ошибка сети";
  if (errorCode === "TIMEOUT") return "Превышено время ожидания";
  return reason ?? "Неизвестная ошибка";
}

function resolveCurrentTrackId(): string | null {
  const meta = extractTrackMeta();
  if (meta !== null && meta.trackId.length > 0) {
    return meta.trackId.split(":")[0];
  }
  const m = location.href.match(/\/track\/(\d+)/);
  if (m !== null) return m[1];
  return null;
}

async function handleFloatingClick(): Promise<void> {
  if (ui === null) return;

  const trackId = resolveCurrentTrackId();
  if (trackId === null) {
    ui.setState("error", "Откройте трек");
    ui.showToast(
      "Не удалось определить трек. Включите воспроизведение.",
      "error",
    );
    window.setTimeout(() => ui?.setState("idle"), 3000);
    return;
  }

  ui.setState("loading");
  try {
    const meta = extractTrackMeta();
    const hint: MetaHint =
      meta !== null
        ? {
            artist: meta.artist !== "Unknown" ? meta.artist : undefined,
            title: meta.title !== "Unknown" ? meta.title : undefined,
          }
        : {};
    // Real byte-level progress callback — drives the conic ring on the
    // floating button via setProgressRingPct.
    const floatingBtn = ui.getElement?.() ?? null;
    const r = await downloadTrackWithTags(trackId, hint, undefined, (pct) => {
      if (floatingBtn !== null) setProgressRingPct(floatingBtn, pct);
    });
    // Кнопка переходит в success-состояние только при двух условиях:
    //   r.success === true (SW не отчитался об ошибке)
    //   typeof r.downloadId === "number" (chrome.downloads.download
    //                                    в SW завершился, файл записан)
    // Любой другой исход — error-состояние. Это закрывает Bug Condition 3
    // для floating-button-flow (Requirements 2.5, 2.6, 3.4).
    if (r.success && typeof r.downloadId === "number") {
      ui.setState("success");
      // Toast «Скачивание началось» намеренно убран: зелёная галочка
      // на кнопке сама по себе достаточный визуальный фидбэк.
      window.setTimeout(() => ui?.setState("idle"), 2000);
    } else {
      ui.setState("error");
      ui.showToast(userMessageForError(r.reason, r.errorCode), "error");
      window.setTimeout(() => ui?.setState("idle"), 4500);
    }
  } catch (e) {
    ui?.setState("error");
    ui?.showToast(e instanceof Error ? e.message : "Ошибка", "error");
    window.setTimeout(() => ui?.setState("idle"), 4500);
  }
}

async function handleRowClick(
  trackId: string,
  btn: HTMLButtonElement,
): Promise<void> {
  flashOverlayButton(btn, "loading", 60_000);
  try {
    const meta = extractMetaFromRow(btn);
    // Real byte-level progress callback — drives the conic ring on the
    // row button via setProgressRingPct.
    const r = await downloadTrackWithTags(trackId, meta, undefined, (pct) => {
      setProgressRingPct(btn, pct);
    });
    // Та же гарантия, что и для floating-button: success-визуал только
    // после возврата `downloadId` от `chrome.downloads.download()` в SW.
    if (r.success && typeof r.downloadId === "number") {
      flashOverlayButton(btn, "success");
      // Toast «Скачивание началось» намеренно убран: зелёная галочка
      // на кнопке трека сама по себе достаточный визуальный фидбэк.
    } else {
      flashOverlayButton(btn, "error");
      ui?.showToast(userMessageForError(r.reason, r.errorCode), "error");
    }
  } catch (e) {
    flashOverlayButton(btn, "error");
    ui?.showToast(e instanceof Error ? e.message : "Ошибка", "error");
  }
}

function extractMetaFromRow(btn: HTMLButtonElement): MetaHint {
  const trackId = btn.getAttribute("data-ymd-track-id") ?? "";
  const rows = Array.from(document.querySelectorAll("[data-ymd-bound]"));
  let row: Element | null = null;
  for (const r of rows) {
    if (r.querySelector(`a[href*="/track/${trackId}"]`) !== null) {
      row = r;
      break;
    }
  }
  if (row === null) return {};

  let title: string | undefined;
  const titleLink = row.querySelector('a[href*="/track/"]');
  if (titleLink !== null) {
    const text = (titleLink.textContent ?? "").trim();
    if (text.length > 0) title = text;
  }
  if (title === undefined) {
    const titleEl = row.querySelector(
      "[class*='Title'], [class*='Name'], [class*='trackName']",
    );
    if (titleEl !== null) {
      const text = (titleEl.textContent ?? "").trim();
      if (text.length > 0) title = text;
    }
  }
  const artistLinks = Array.from(row.querySelectorAll('a[href*="/artist/"]'));
  let artist: string | undefined;
  if (artistLinks.length > 0) {
    const names = artistLinks
      .map((a) => (a.textContent ?? "").trim())
      .filter((n) => n.length > 0);
    if (names.length > 0) artist = names.join(", ");
  }
  return { artist, title };
}

function init(): void {
  // 0. Start the bridge listener as early as possible so any track event
  //    that the page bridge fired between document_start and now lands
  //    in the listener's cache. Cheap to call multiple times (idempotent).
  try {
    startYmBridgeListener();
  } catch (e) {
    console.error("[ymd][content] startYmBridgeListener", e);
  }

  // 1. Удалить следы старой плавающей кнопки "Скачать всё" (Requirement 2).
  //    Запускаем санитайзер ДО построения нового UI, чтобы в одном тике
  //    рендера у пользователя не оказалось двух вариантов кнопки одновременно.
  try {
    removeLegacyBulkArtifacts();
  } catch (e) {
    console.error("[ymd][content] removeLegacyBulkArtifacts", e);
  }
  try {
    startLegacyBulkSanitizer();
  } catch (e) {
    console.error("[ymd][content] startLegacyBulkSanitizer", e);
  }

  // 2. Существующие компоненты UI.
  try {
    ui = ensureFloatingButton(() => {
      void handleFloatingClick();
    });
    startFloatingButtonGuard(() => {
      void handleFloatingClick();
    });
  } catch (e) {
    console.error("[ymd][content] floating button", e);
  }

  try {
    startTrackRowInjector((trackId, btn) => {
      void handleRowClick(trackId, btn);
    });
  } catch (e) {
    console.error("[ymd][content] track row injector", e);
  }

  // 3. Новая кнопка "Скачать плейлист" в шапке плейлиста
  //    (Requirements 3, 4, 5).
  try {
    startPlaylistHeaderButton({
      notify: (text, kind) => ui?.showToast(text, kind),
    });
  } catch (e) {
    console.error("[ymd][content] playlist header button", e);
  }

  // 4. Кнопки скачивания на странице поиска (Requirements 11.5, 11.6).
  try {
    startSearchTrackInjector({
      notify: (text, kind) => ui?.showToast(text, kind),
    });
  } catch (e) {
    console.error("[ymd][content] search track injector", e);
  }

  // 5. Кнопки скачивания на обложках альбомов/плейлистов и карточках карусели
  //    (Requirements 11.5, 11.6).
  try {
    startCoverButtonInjector({
      notify: (text, kind) => ui?.showToast(text, kind),
    });
  } catch (e) {
    console.error("[ymd][content] cover button injector", e);
  }

  // 6. Кнопки скачивания по дате на странице истории прослушиваний
  //    (Requirements 1.1, 1.3).
  try {
    startHistoryInjector({
      notify: (text, kind) => ui?.showToast(text, kind),
    });
  } catch (e) {
    console.error("[ymd][content] history injector", e);
  }

  // 7. Ссылка "Чарт" в сайдбаре навигации.
  try {
    startSidebarChartLink();
  } catch (e) {
    console.error("[ymd][content] sidebar chart link", e);
  }
}

try {
  if (document.body !== null) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
} catch (e) {
  console.error("[ymd][content]", e);
}
