// Popup: мультисервисный интерфейс с табами для Yandex Music, VK, YouTube, Spotify.
// Управляет OAuth-авторизацией, выбором формата скачивания и переключением вкладок.

import {
  getFormatPreferences,
  setFormatPreferences,
  getServiceFormatPreferences,
  setServiceFormatPreferences,
} from "../shared/format-storage";
import type { AudioFormat } from "../shared/types";
import { buildFallbackMessage } from "./fallback-message";
import { switchTab, getActiveTab, setActiveTab, SERVICE_TABS } from "./tab-controller";
import { getYouTubePreferences, setYouTubePreferences } from "./youtube-storage";
import { getLegalBlockHtml } from "./legal-blocks";

// ─── Yandex Music elements ───────────────────────────────────────────────────

const inputEl = document.getElementById("input") as HTMLInputElement | null;
const downloadBtn = document.getElementById("download") as HTMLButtonElement | null;
const pasteBtn = document.getElementById("paste-current") as HTMLButtonElement | null;
const statusEl = document.getElementById("status") as HTMLDivElement | null;
const authStatusEl = document.getElementById("auth-status") as HTMLDivElement | null;
const authBtn = document.getElementById("auth-btn") as HTMLButtonElement | null;
const formatSingleEl = document.getElementById("format-single") as HTMLSelectElement | null;
const formatBulkEl = document.getElementById("format-bulk") as HTMLSelectElement | null;

const VALID_FORMATS: readonly AudioFormat[] = ["mp3", "flac", "wav"];

function isValidFormat(value: string): value is AudioFormat {
  return (VALID_FORMATS as readonly string[]).includes(value);
}

let authorized = false;

function isYandexMusicUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === "music.yandex.ru" || host === "music.yandex.com";
  } catch {
    return false;
  }
}

function setStatus(text: string, kind: "info" | "success" | "error"): void {
  if (statusEl === null) return;
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function clearStatus(): void {
  if (statusEl === null) return;
  statusEl.textContent = "";
  statusEl.className = "status";
}

function setBusy(busy: boolean): void {
  if (downloadBtn !== null) {
    downloadBtn.disabled = busy;
    downloadBtn.textContent = busy ? "Загрузка…" : "Скачать";
    downloadBtn.classList.toggle("loading", busy);
  }
  if (pasteBtn !== null) pasteBtn.disabled = busy;
}

function renderAuth(): void {
  if (authStatusEl === null || authBtn === null) return;
  if (authorized) {
    authStatusEl.textContent = "Аккаунт подключён";
    authStatusEl.className = "auth-status ok";
    authBtn.textContent = "Отключить";
  } else {
    authStatusEl.textContent = "Аккаунт не подключён";
    authStatusEl.className = "auth-status no";
    authBtn.textContent = "Подключить";
  }
}

async function refreshAuthStatus(): Promise<void> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: "AUTH_STATUS" })) as
      | { success: boolean; authorized?: boolean }
      | undefined;
    authorized = r?.authorized === true;
  } catch {
    authorized = false;
  }
  renderAuth();
}

async function handleAuthClick(): Promise<void> {
  if (authorized) {
    await chrome.runtime.sendMessage({ type: "AUTH_LOGOUT" });
    authorized = false;
    renderAuth();
    setStatus("Аккаунт отключён", "info");
    return;
  }
  setStatus("Открываю окно авторизации Яндекса...", "info");
  try {
    const r = (await chrome.runtime.sendMessage({ type: "OAUTH_LOGIN" })) as
      | { success: boolean; reason?: string }
      | undefined;
    if (r === undefined || !r.success) {
      setStatus(
        r?.reason ?? "Авторизация отменена. Если окно не открылось — попробуйте ручной ввод ниже.",
        "error",
      );
      return;
    }
    await refreshAuthStatus();
    if (authorized) {
      setStatus("Аккаунт подключён, готов к скачиванию", "success");
    } else {
      setStatus("Не удалось получить токен", "error");
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : "Ошибка авторизации", "error");
  }
}

async function handleDownload(): Promise<void> {
  if (inputEl === null) return;
  const input = inputEl.value.trim();
  if (input.length === 0) {
    setStatus("Введите ссылку или ID трека", "error");
    return;
  }
  if (!authorized) {
    setStatus("Сначала подключите аккаунт (кнопка выше)", "error");
    return;
  }

  clearStatus();
  setBusy(true);
  setStatus("Получаю ссылку...", "info");

  let preferredSingleFormat: AudioFormat = "mp3";
  try {
    const prefs = await getFormatPreferences();
    preferredSingleFormat = prefs.singleTrackFormat;
  } catch {
    /* fallback to mp3 */
  }

  try {
    const r = (await chrome.runtime.sendMessage({
      type: "DOWNLOAD_BY_INPUT",
      payload: { input },
    })) as
      | {
          success: boolean;
          reason?: string;
          errorCode?: string;
          actualFormat?: AudioFormat;
          fallbackReason?: string;
          downloadId?: number;
        }
      | undefined;

    if (r === undefined) {
      setStatus("Service Worker не ответил", "error");
      return;
    }
    if (r.success && typeof r.downloadId === "number") {
      const fellBack =
        r.actualFormat !== undefined && r.actualFormat !== preferredSingleFormat;
      if (fellBack) {
        const message = buildFallbackMessage(
          preferredSingleFormat,
          r.actualFormat as AudioFormat,
          r.fallbackReason,
        );
        setStatus(message, "info");
      } else {
        setStatus("Скачивание началось", "success");
      }
      return;
    }
    if (r.success) {
      setStatus("Файл не записан в систему", "error");
      return;
    }
    if (r.errorCode === "AUTH_REQUIRED") {
      authorized = false;
      renderAuth();
      setStatus(r.reason ?? "Нужно подключить аккаунт", "error");
      return;
    }
    setStatus(r.reason ?? "Ошибка", "error");
  } catch (e) {
    setStatus(e instanceof Error ? e.message : "Ошибка", "error");
  } finally {
    setBusy(false);
  }
}

async function handlePasteCurrent(): Promise<void> {
  if (inputEl === null) return;
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const url = tab?.url;
    if (isYandexMusicUrl(url)) {
      inputEl.value = url;
      inputEl.focus();
      clearStatus();
    } else {
      setStatus("Активная вкладка — не Яндекс Музыка", "error");
    }
  } catch (e) {
    setStatus("Не удалось получить URL вкладки", "error");
    console.error("[ymd][popup]", e);
  }
}

async function initFormatSelectors(): Promise<void> {
  if (formatSingleEl === null && formatBulkEl === null) return;

  try {
    const prefs = await getFormatPreferences();
    if (formatSingleEl !== null) formatSingleEl.value = prefs.singleTrackFormat;
    if (formatBulkEl !== null) formatBulkEl.value = prefs.bulkFormat;
  } catch (e) {
    console.error("[ymd][popup] format prefs load failed", e);
  }

  if (formatSingleEl !== null) {
    formatSingleEl.addEventListener("change", () => {
      const value = formatSingleEl.value;
      if (!isValidFormat(value)) return;
      void setFormatPreferences({ singleTrackFormat: value }).catch((e) => {
        console.error("[ymd][popup] format prefs save failed", e);
      });
    });
  }

  if (formatBulkEl !== null) {
    formatBulkEl.addEventListener("change", () => {
      const value = formatBulkEl.value;
      if (!isValidFormat(value)) return;
      void setFormatPreferences({ bulkFormat: value }).catch((e) => {
        console.error("[ymd][popup] format prefs save failed", e);
      });
    });
  }
}

// ─── Yandex Music tab initialization ─────────────────────────────────────────

function initYandexMusicTab(): void {
  void refreshAuthStatus();
  void initFormatSelectors();

  if (authBtn !== null) {
    authBtn.addEventListener("click", () => {
      void handleAuthClick();
    });
  }

  // Кнопка ручного сохранения токена (fallback).
  const manualTokenInput = document.getElementById(
    "manual-token-input",
  ) as HTMLInputElement | null;
  const manualTokenSave = document.getElementById(
    "manual-token-save",
  ) as HTMLButtonElement | null;
  if (manualTokenSave !== null && manualTokenInput !== null) {
    manualTokenSave.addEventListener("click", () => {
      void (async () => {
        const raw = manualTokenInput.value.trim();
        if (raw.length === 0) {
          setStatus("Вставьте токен в поле выше", "error");
          return;
        }
        let token = raw;
        const m = raw.match(/access_token=([^&]+)/);
        if (m !== null) token = m[1];
        await chrome.runtime.sendMessage({
          type: "OAUTH_TOKEN_RECEIVED",
          payload: { token },
        });
        await refreshAuthStatus();
        if (authorized) {
          setStatus("Токен сохранён", "success");
          manualTokenInput.value = "";
        } else {
          setStatus("Не удалось сохранить токен", "error");
        }
      })();
    });
  }

  if (downloadBtn !== null) {
    downloadBtn.addEventListener("click", () => {
      void handleDownload();
    });
  }
  if (pasteBtn !== null) {
    pasteBtn.addEventListener("click", () => {
      void handlePasteCurrent();
    });
  }
  if (inputEl !== null) {
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void handleDownload();
    });
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        const url = tab?.url;
        if (isYandexMusicUrl(url) && /\/track\/\d+/.test(url)) {
          inputEl.value = url;
        }
      } catch {
        /* ignore */
      }
    })();
  }
}

// ─── VK tab initialization ───────────────────────────────────────────────────

function initVkTab(): void {
  const vkSingleEl = document.getElementById("vk-format-single") as HTMLSelectElement | null;
  const vkBulkEl = document.getElementById("vk-format-bulk") as HTMLSelectElement | null;
  const vkWarningEl = document.getElementById("vk-transcode-warning") as HTMLDivElement | null;

  if (vkSingleEl === null && vkBulkEl === null) return;

  function updateVkTranscodeWarning(): void {
    if (vkWarningEl === null) return;
    const singleVal = vkSingleEl?.value ?? "mp3";
    const bulkVal = vkBulkEl?.value ?? "mp3";
    const shouldShow = singleVal !== "mp3" || bulkVal !== "mp3";
    vkWarningEl.style.display = shouldShow ? "block" : "none";
  }

  // Load saved preferences
  void (async () => {
    try {
      const prefs = await getServiceFormatPreferences("vk");
      if (vkSingleEl !== null) vkSingleEl.value = prefs.singleTrackFormat;
      if (vkBulkEl !== null) vkBulkEl.value = prefs.bulkFormat;
    } catch (e) {
      console.error("[ymd][popup] VK format prefs load failed", e);
    }
    updateVkTranscodeWarning();
  })();

  if (vkSingleEl !== null) {
    vkSingleEl.addEventListener("change", () => {
      const value = vkSingleEl.value;
      if (!isValidFormat(value)) return;
      void setServiceFormatPreferences("vk", { singleTrackFormat: value }).catch((e) => {
        console.error("[ymd][popup] VK format prefs save failed", e);
      });
      updateVkTranscodeWarning();
    });
  }

  if (vkBulkEl !== null) {
    vkBulkEl.addEventListener("change", () => {
      const value = vkBulkEl.value;
      if (!isValidFormat(value)) return;
      void setServiceFormatPreferences("vk", { bulkFormat: value }).catch((e) => {
        console.error("[ymd][popup] VK format prefs save failed", e);
      });
      updateVkTranscodeWarning();
    });
  }
}

// ─── YouTube tab initialization ──────────────────────────────────────────────

function initYouTubeTab(): void {
  const qualityEl = document.getElementById("yt-quality") as HTMLSelectElement | null;
  const modeEl = document.getElementById("yt-download-mode") as HTMLSelectElement | null;

  if (qualityEl === null && modeEl === null) return;

  // Load saved preferences
  void (async () => {
    try {
      const prefs = await getYouTubePreferences();
      if (qualityEl !== null) qualityEl.value = prefs.quality;
      if (modeEl !== null) modeEl.value = prefs.downloadMode;
    } catch (e) {
      console.error("[ymd][popup] YouTube prefs load failed", e);
    }
  })();

  if (qualityEl !== null) {
    qualityEl.addEventListener("change", () => {
      const previousValue = qualityEl.dataset.lastValue ?? qualityEl.value;
      qualityEl.dataset.lastValue = qualityEl.value;
      void setYouTubePreferences({ quality: qualityEl.value as never }).catch((e) => {
        console.error("[ymd][popup] YouTube quality save failed", e);
        // Revert on failure
        qualityEl.value = previousValue;
        qualityEl.dataset.lastValue = previousValue;
        qualityEl.classList.add("error");
        setTimeout(() => qualityEl.classList.remove("error"), 2000);
      });
    });
  }

  if (modeEl !== null) {
    modeEl.addEventListener("change", () => {
      const previousValue = modeEl.dataset.lastValue ?? modeEl.value;
      modeEl.dataset.lastValue = modeEl.value;
      void setYouTubePreferences({ downloadMode: modeEl.value as never }).catch((e) => {
        console.error("[ymd][popup] YouTube mode save failed", e);
        // Revert on failure
        modeEl.value = previousValue;
        modeEl.dataset.lastValue = previousValue;
        modeEl.classList.add("error");
        setTimeout(() => modeEl.classList.remove("error"), 2000);
      });
    });
  }
}

// ─── Spotify tab initialization ──────────────────────────────────────────────

function initSpotifyTab(): void {
  const spotifySingleEl = document.getElementById("spotify-format-single") as HTMLSelectElement | null;
  const spotifyBulkEl = document.getElementById("spotify-format-bulk") as HTMLSelectElement | null;

  if (spotifySingleEl === null && spotifyBulkEl === null) return;

  // Load saved preferences
  void (async () => {
    try {
      const prefs = await getServiceFormatPreferences("spotify");
      if (spotifySingleEl !== null) spotifySingleEl.value = prefs.singleTrackFormat;
      if (spotifyBulkEl !== null) spotifyBulkEl.value = prefs.bulkFormat;
    } catch (e) {
      console.error("[ymd][popup] Spotify format prefs load failed", e);
    }
  })();

  if (spotifySingleEl !== null) {
    spotifySingleEl.addEventListener("change", () => {
      const value = spotifySingleEl.value;
      if (!isValidFormat(value)) return;
      void setServiceFormatPreferences("spotify", { singleTrackFormat: value }).catch((e) => {
        console.error("[ymd][popup] Spotify format prefs save failed", e);
      });
    });
  }

  if (spotifyBulkEl !== null) {
    spotifyBulkEl.addEventListener("change", () => {
      const value = spotifyBulkEl.value;
      if (!isValidFormat(value)) return;
      void setServiceFormatPreferences("spotify", { bulkFormat: value }).catch((e) => {
        console.error("[ymd][popup] Spotify format prefs save failed", e);
      });
    });
  }
}

// ─── Legal blocks ────────────────────────────────────────────────────────────

function initLegalBlocks(): void {
  const containers: Array<{ id: string; service: "yandex-music" | "vk" | "youtube" | "spotify" }> = [
    { id: "legal-yandex-music", service: "yandex-music" },
    { id: "legal-vk", service: "vk" },
    { id: "legal-youtube", service: "youtube" },
    { id: "legal-spotify", service: "spotify" },
  ];

  for (const { id, service } of containers) {
    const el = document.getElementById(id);
    if (el !== null) {
      el.innerHTML = getLegalBlockHtml(service);
    }
  }
}

// ─── Tab bar wiring ──────────────────────────────────────────────────────────

function initTabBar(): void {
  const tabButtons = document.querySelectorAll<HTMLButtonElement>(".tab-bar button[data-tab]");

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      if (!tabId) return;

      // Update active class on tab buttons
      tabButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      // Update active class on panels
      const panels = document.querySelectorAll<HTMLElement>(".tab-panel");
      panels.forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.tab === tabId);
      });

      // Call switchTab for CSS variable updates and panel display
      switchTab(tabId as "yandex-music" | "vk" | "youtube" | "spotify");

      // Persist tab selection
      void setActiveTab(tabId as "yandex-music" | "vk" | "youtube" | "spotify").catch(() => {
        console.warn("[ymd][popup] Failed to persist active tab");
      });

      // Refresh auth status when Yandex Music tab becomes visible
      if (tabId === "yandex-music") {
        void refreshAuthStatus();
      }
    });
  });
}

// ─── Restore active tab on startup ──────────────────────────────────────────

async function restoreActiveTab(): Promise<void> {
  try {
    const activeId = await getActiveTab();
    switchTab(activeId);

    // Update active class on tab buttons
    const tabButtons = document.querySelectorAll<HTMLButtonElement>(".tab-bar button[data-tab]");
    tabButtons.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === activeId);
    });

    // Update active class on panels
    const panels = document.querySelectorAll<HTMLElement>(".tab-panel");
    panels.forEach((panel) => {
      panel.classList.toggle("active", panel.dataset.tab === activeId);
    });
  } catch {
    // Default: Yandex Music already active in HTML
  }
}

// ─── Main init ───────────────────────────────────────────────────────────────

function init(): void {
  // Anti-distribution check
  chrome.management.getSelf((info) => {
    if (info.installType !== "development") {
      document.body.innerHTML = `
        <div style="padding:24px;text-align:center;color:#ff6961;font-family:sans-serif;">
          <h3 style="margin:0 0 12px;">⛔ Доступ заблокирован</h3>
          <p style="font-size:13px;color:#aaa;margin:0;">Сработала защита от несанкционированного распространения.<br>Расширение работает только при загрузке из оригинального источника.</p>
        </div>
      `;
      return;
    }
    initApp();
  });
}

function initApp(): void {
  // Restore active tab and set accent color
  void restoreActiveTab();

  // Wire tab bar
  initTabBar();

  // Initialize each service tab
  initYandexMusicTab();
  initVkTab();
  initYouTubeTab();
  initSpotifyTab();

  // Render legal blocks
  initLegalBlocks();

  // Refresh auth status when popup becomes visible again
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshAuthStatus();
  });
}

init();
