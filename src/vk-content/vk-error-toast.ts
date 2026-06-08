/**
 * Centralized error reporting for VK content script.
 *
 * Every user-visible error gets a stable error code (like "VK-CLICK-META-NULL")
 * and a Russian-language message. The toast that the user sees has THREE parts:
 *
 *   1. The human message ("Не удалось извлечь данные трека")
 *   2. The error code in monospace ("VK-CLICK-META-NULL")
 *   3. A hint to report it ("Сообщите разработчику этот код")
 *
 * The code is what the user copies into a bug report. It's also written
 * to console.error and to data-ymus-last-error on document.body so we can
 * grab it from a screenshot of DevTools or a script-injected probe.
 */

/** All error codes used by the VK content script. Keep this list as the single source of truth. */
export const VK_ERROR_CODES = {
  // Click handler — row button
  CLICK_META_NULL: "VK-CLICK-META-NULL",
  CLICK_REF_NULL: "VK-CLICK-REF-NULL",
  CLICK_ORPHANED_ROW: "VK-CLICK-ORPHANED-ROW",
  CLICK_EXCEPTION: "VK-CLICK-EXCEPTION",

  // Click handler — player overlay button
  PLAYER_NO_TRACK: "VK-PLAYER-NO-TRACK",
  PLAYER_TIMEOUT: "VK-PLAYER-TIMEOUT",

  // Download flow
  DOWNLOAD_NO_URL: "VK-DOWNLOAD-NO-URL",
  DOWNLOAD_NETWORK: "VK-DOWNLOAD-NETWORK",
  DOWNLOAD_DECRYPT: "VK-DOWNLOAD-DECRYPT",
  DOWNLOAD_DEMUX: "VK-DOWNLOAD-DEMUX",
  DOWNLOAD_FILE_SAVE: "VK-DOWNLOAD-FILE-SAVE",

  // Playlist
  PLAYLIST_BUTTON_NOT_INJECTED: "VK-PLAYLIST-BTN-NOT-INJECTED",
  PLAYLIST_NO_TRACKS: "VK-PLAYLIST-NO-TRACKS",
  PLAYLIST_EXCEPTION: "VK-PLAYLIST-EXCEPTION",

  // Page bridge
  BRIDGE_TIMEOUT: "VK-BRIDGE-TIMEOUT",
  BRIDGE_NO_PLAYER: "VK-BRIDGE-NO-PLAYER",
} as const;

export type VkErrorCode = (typeof VK_ERROR_CODES)[keyof typeof VK_ERROR_CODES];

/** Default human-readable Russian messages for each error code. */
const DEFAULT_MESSAGES: Record<VkErrorCode, string> = {
  "VK-CLICK-META-NULL": "Не удалось извлечь данные трека",
  "VK-CLICK-REF-NULL": "Расширение ещё не готово, попробуйте через секунду",
  "VK-CLICK-ORPHANED-ROW": "Строка трека пропала со страницы",
  "VK-CLICK-EXCEPTION": "Ошибка при обработке клика",
  "VK-PLAYER-NO-TRACK": "Не удалось определить текущий трек",
  "VK-PLAYER-TIMEOUT": "Плеер VK не ответил вовремя",
  "VK-DOWNLOAD-NO-URL": "Не удалось получить ссылку на трек",
  "VK-DOWNLOAD-NETWORK": "Сетевая ошибка при скачивании",
  "VK-DOWNLOAD-DECRYPT": "Ошибка расшифровки сегмента",
  "VK-DOWNLOAD-DEMUX": "Ошибка разбора аудио-потока",
  "VK-DOWNLOAD-FILE-SAVE": "Не удалось сохранить файл",
  "VK-PLAYLIST-BTN-NOT-INJECTED": "Кнопка плейлиста не нашла куда встроиться",
  "VK-PLAYLIST-NO-TRACKS": "Не удалось найти треки плейлиста",
  "VK-PLAYLIST-EXCEPTION": "Ошибка при обработке плейлиста",
  "VK-BRIDGE-TIMEOUT": "Внутренний канал расширения не ответил",
  "VK-BRIDGE-NO-PLAYER": "VK-плеер недоступен",
};

let stylesInjected = false;
function injectErrorStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "ymus-vk-error-toast-styles";
  style.textContent = `
    .ymus-vk-err-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      max-width: 360px;
      background: #1d1d1f;
      color: #fff;
      padding: 12px 16px;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.4;
      z-index: 99999;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
      border-left: 4px solid #e64646;
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      animation: ymus-toast-in 0.18s ease-out;
    }
    .ymus-vk-err-toast__msg {
      margin-bottom: 6px;
    }
    .ymus-vk-err-toast__code {
      display: inline-block;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 12px;
      background: rgba(230, 70, 70, 0.18);
      color: #ffd1d1;
      padding: 2px 8px;
      border-radius: 4px;
      letter-spacing: 0.3px;
      cursor: pointer;
      user-select: all;
      -webkit-user-select: all;
    }
    .ymus-vk-err-toast__hint {
      margin-top: 6px;
      color: #b8c4d0;
      font-size: 11.5px;
    }
    .ymus-vk-err-toast__close {
      position: absolute;
      top: 6px;
      right: 8px;
      background: transparent;
      border: none;
      color: #939fad;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 2px 6px;
    }
    .ymus-vk-err-toast__close:hover {
      color: #fff;
    }
    @keyframes ymus-toast-in {
      from { opacity: 0; transform: translateX(20px); }
      to { opacity: 1; transform: translateX(0); }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Show an error toast with a stable error code the user can report.
 *
 * @param code      Stable identifier from VK_ERROR_CODES.
 * @param details   Optional override of the human message, or extra context appended to it.
 * @param logCtx    Optional structured object logged to console.error for the developer.
 */
export function showVkError(code: VkErrorCode, details?: string, logCtx?: unknown): void {
  injectErrorStyles();

  const message = details ?? DEFAULT_MESSAGES[code] ?? "Произошла ошибка";

  // Console — full context for the developer
  console.error(`[YMus ${code}]`, message, logCtx ?? "");

  // Persistent breadcrumb on body — survives even if VK suppresses console
  try {
    document.body.setAttribute("data-ymus-last-error", `${code}: ${message}`);
  } catch {}

  // Visible toast — what the user sees
  const toast = document.createElement("div");
  toast.className = "ymus-vk-err-toast";
  toast.setAttribute("role", "alert");
  toast.innerHTML = `
    <button class="ymus-vk-err-toast__close" aria-label="Закрыть">×</button>
    <div class="ymus-vk-err-toast__msg"></div>
    <span class="ymus-vk-err-toast__code"></span>
    <div class="ymus-vk-err-toast__hint">Кликните по коду чтобы скопировать, и пришлите его разработчику</div>
  `;
  const msgEl = toast.querySelector(".ymus-vk-err-toast__msg") as HTMLDivElement;
  const codeEl = toast.querySelector(".ymus-vk-err-toast__code") as HTMLSpanElement;
  const closeBtn = toast.querySelector(".ymus-vk-err-toast__close") as HTMLButtonElement;
  msgEl.textContent = message;
  codeEl.textContent = code;

  const remove = () => {
    if (toast.parentElement) toast.remove();
  };
  closeBtn.addEventListener("click", remove);

  // Click on the code → copy to clipboard
  codeEl.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      const orig = codeEl.textContent;
      codeEl.textContent = "Скопировано!";
      setTimeout(() => { codeEl.textContent = orig; }, 1200);
    } catch {
      // Fallback: select the text so the user can ctrl+c
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  });

  document.body.appendChild(toast);
  setTimeout(remove, 8000); // Errors stay longer than success toasts
}

/** Plain success/info toast — kept here so all UI feedback comes from one module. */
export function showVkInfo(message: string, durationMs = 4000): void {
  const toast = document.createElement("div");
  toast.className = "ymus-vk-toast";
  toast.textContent = message;
  toast.style.cssText = `position:fixed;bottom:24px;right:24px;background:#1d1d1f;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:99999;box-shadow:0 4px 12px rgba(0,0,0,0.3);font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
}
