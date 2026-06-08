// OAuth-флоу: открываем oauth.yandex.ru/authorize, ловим токен из URL
// через chrome.tabs.onUpdated и chrome.webNavigation events.

import { setStoredToken, YANDEX_MUSIC_CLIENT_ID } from "../shared/auth";
import { logError } from "./logger";

const AUTH_URL = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YANDEX_MUSIC_CLIENT_ID}&force_confirm=yes`;

function extractTokenFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const hash = u.hash.startsWith("#") ? u.hash.substring(1) : u.hash;
    if (hash.length > 0) {
      const p = new URLSearchParams(hash);
      const t = p.get("access_token");
      if (typeof t === "string" && t.length > 0) return t;
    }
    const q = u.searchParams.get("access_token");
    if (typeof q === "string" && q.length > 0) return q;
    return null;
  } catch {
    return null;
  }
}

function isYandexOauthHost(hostname: string): boolean {
  return (
    hostname === "oauth.yandex.ru" ||
    hostname === "oauth.yandex.com" ||
    hostname.endsWith(".yandex.ru") ||
    hostname.endsWith(".yandex.com")
  );
}

/**
 * Запускает авторизацию: открывает вкладку, слушает её URL до тех пор,
 * пока в нём не появится access_token. Возвращает токен.
 */
export async function authorize(): Promise<string> {
  const tab = await chrome.tabs.create({ url: AUTH_URL });
  const tabId = tab.id;
  if (tabId === undefined) {
    throw new Error("Не удалось открыть вкладку для OAuth");
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const TIMEOUT_MS = 180_000; // 3 минуты на авторизацию

    const finish = (
      result: { ok: true; token: string } | { ok: false; reason: string },
    ): void => {
      if (done) return;
      done = true;
      cleanup();
      if (result.ok) {
        // Закрыть вкладку и отдать токен.
        chrome.tabs.remove(tabId).catch(() => {
          /* ignore */
        });
        resolve(result.token);
      } else {
        reject(new Error(result.reason));
      }
    };

    const onUpdated = (
      updatedTabId: number,
      _changeInfo: chrome.tabs.TabChangeInfo,
      tabInfo: chrome.tabs.Tab,
    ): void => {
      if (updatedTabId !== tabId) return;
      const url = tabInfo.url ?? "";
      if (url.length === 0) return;

      try {
        const u = new URL(url);
        if (!isYandexOauthHost(u.hostname)) return;
      } catch {
        return;
      }

      const token = extractTokenFromUrl(url);
      if (token !== null) {
        finish({ ok: true, token });
      }
    };

    const onRemoved = (removedTabId: number): void => {
      if (removedTabId !== tabId) return;
      finish({
        ok: false,
        reason: "Окно авторизации закрыто без получения токена",
      });
    };

    const cleanup = (): void => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timeoutHandle);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    const timeoutHandle = setTimeout(() => {
      finish({
        ok: false,
        reason: "Таймаут авторизации (3 минуты)",
      });
    }, TIMEOUT_MS);
  });
}

/**
 * Сохраняет полученный токен и возвращает его. Используется обёрткой
 * authorize и при ручном вводе.
 */
export async function saveToken(token: string): Promise<void> {
  await setStoredToken(token);
}

/**
 * Запускает OAuth и сохраняет токен. Альтернативный путь — пользователь
 * сам копирует URL после редиректа и вставляет в попап.
 */
export async function authorizeAndSave(): Promise<void> {
  try {
    const token = await authorize();
    await saveToken(token);
  } catch (e) {
    logError("oauth", e);
    throw e;
  }
}
