// Toast-уведомления для Spotify content script.
//
// Модуль содержит:
//   * Замкнутый словарь `SPOTIFY_ERROR_MESSAGES` — ровно 11 русских сообщений
//     для всех литералов `SpotifyErrorCode` (см. design.md § L). TypeScript
//     требует исчерпывающего покрытия, поэтому добавление нового кода в
//     `SpotifyErrorCode` без обновления словаря даст ошибку компиляции.
//   * `showSpotifyError(code, override?, ctx?)` — показывает toast красного
//     акцента и сохраняет breadcrumb в `document.body` для диагностики.
//   * `showSpotifyInfo(text)` — нейтральный toast (используется будущими
//     UI-инжекторами, R15.6/R16.2).
//
// Гарантия R15.5 / R22.2: любая ошибка создания toast (отсутствие
// `document`, `document.body` ещё не существует, исключение в DOM API)
// поглощается внутри модуля; вызывающий код спокойно продолжает менять
// состояние кнопки и не получает исключения.

import type { SpotifyErrorCode } from "../shared/spotify-types";

/**
 * Русскоязычные сообщения для каждого кода ошибки Spotify-пайплайна.
 * Текст согласован с design.md секция L (Error taxonomy).
 *
 * Тип `Record<SpotifyErrorCode, string>` гарантирует, что при добавлении
 * нового литерала в `SpotifyErrorCode` TypeScript потребует обновить и
 * этот словарь.
 */
export const SPOTIFY_ERROR_MESSAGES: Record<SpotifyErrorCode, string> = {
  SPOTIFY_TOKEN_UNAVAILABLE:
    "Откройте вкладку open.spotify.com или запустите воспроизведение любого трека, чтобы расширение получило токен",
  SPOTIFY_TOKEN_EXPIRED:
    "Сессия Spotify истекла, обновите страницу open.spotify.com",
  SPOTIFY_TRACK_ID_INVALID:
    "Не удалось определить трек. Попробуйте обновить страницу",
  SPOTIFY_METADATA_FAILED: "Не удалось получить данные трека из Spotify",
  SPOTIFY_DRM_PROTECTED: "Трек защищён DRM, скачивание невозможно",
  SPOTIFY_STORAGE_RESOLVE_FAILED:
    "Spotify не предоставил ссылку на аудио. Попробуйте позже",
  SPOTIFY_AUDIO_KEY_FAILED: "Не удалось получить ключ расшифровки трека",
  SPOTIFY_CDN_FETCH_FAILED: "Ошибка скачивания файла с Spotify CDN",
  SPOTIFY_DECRYPT_FAILED: "Не удалось расшифровать аудио",
  SPOTIFY_TRANSCODE_FAILED: "Ошибка транскодирования в MP3",
  SPOTIFY_DOWNLOAD_FAILED: "Не удалось сохранить файл",
};

/** id `<style>` со стилями toast — переиспользуется между вызовами. */
const STYLES_ELEMENT_ID = "ymus-spotify-toast-styles";

/** Длительность toast по умолчанию (R15.6). */
const TOAST_DURATION_MS = 4000;

/**
 * Показать пользователю toast об ошибке.
 *
 * @param code     стабильный код из union `SpotifyErrorCode`
 * @param override если передан — заменяет сообщение из словаря
 * @param ctx      опциональный технический контекст; если задан, добавляется
 *                 к тексту в скобках (например, HTTP-статус или причина)
 */
export function showSpotifyError(
  code: SpotifyErrorCode,
  override?: string,
  ctx?: string,
): void {
  // Внешний try/catch гарантирует, что вызывающий код не получит исключения
  // (R15.5 / R22.2): даже если document.body отсутствует, либо браузер
  // выбросил DOMException, мы всё равно молча продолжаем.
  try {
    const base = override ?? SPOTIFY_ERROR_MESSAGES[code] ?? "Произошла ошибка";
    const text = ctx !== undefined && ctx.length > 0 ? `${base} (${ctx})` : base;
    // Лог в консоль — для разработчика; не должен блокировать показ toast.
    try {
      // eslint-disable-next-line no-console
      console.error(`[YMus ${code}]`, text);
    } catch {
      // console может быть недоступен в каких-то edge-case sandbox'ах.
    }
    renderToast(text, "error");
  } catch {
    // Намеренно глотаем — состояние кнопки меняется независимо от toast.
  }
}

/**
 * Показать пользователю информационный toast (используется будущими
 * UI-обработчиками успеха/прогресса).
 */
export function showSpotifyInfo(text: string): void {
  try {
    renderToast(text, "info");
  } catch {
    // см. комментарий в showSpotifyError — toast не блокирует логику.
  }
}

/** Создать и вставить toast в DOM с автоматическим удалением через 4000 мс. */
function renderToast(text: string, kind: "error" | "info"): void {
  if (typeof document === "undefined") return;
  const body = document.body;
  if (body === null) return;

  ensureToastStyles();

  const toast = document.createElement("div");
  toast.className = `ymus-spotify-toast ymus-spotify-toast--${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.textContent = text;
  body.appendChild(toast);

  const remove = (): void => {
    // parentElement может уже быть null, если узел удалили извне.
    if (toast.parentElement !== null) {
      toast.parentElement.removeChild(toast);
    }
  };
  setTimeout(remove, TOAST_DURATION_MS);
}

/**
 * Однократно вставить блок стилей в `document.head`. Стили оформлены в
 * стиле `.ymus-vk-toast` (см. `vk-error-toast.ts`): фиксированная
 * позиция в правом-нижнем углу, тёмный фон, скруглённые углы, тень и
 * лёгкая fade-in анимация. Акцентный цвет error — `#e64646` (как в VK),
 * info — Spotify green `#1ed760`.
 */
function ensureToastStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLES_ELEMENT_ID) !== null) return;
  // document.head может отсутствовать в очень ранних состояниях DOM.
  const head = document.head ?? document.documentElement;
  if (head === null) return;

  const style = document.createElement("style");
  style.id = STYLES_ELEMENT_ID;
  style.textContent = `
    .ymus-spotify-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      max-width: 360px;
      padding: 12px 16px;
      border-radius: 10px;
      font-size: 13px;
      line-height: 1.4;
      color: #ffffff;
      background: #1d1d1f;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      z-index: 99999;
      animation: ymus-spotify-toast-in 0.18s ease-out;
    }
    .ymus-spotify-toast--error {
      border-left: 4px solid #e64646;
    }
    .ymus-spotify-toast--info {
      border-left: 4px solid #1ed760;
    }
    @keyframes ymus-spotify-toast-in {
      from { opacity: 0; transform: translateX(20px); }
      to { opacity: 1; transform: translateX(0); }
    }
  `;
  head.appendChild(style);
}
