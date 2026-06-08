// Хранение и получение OAuth-токена Яндекс Музыки.
//
// Используется публичный client_id мобильного клиента — тот же, что
// у всех неофициальных downloader'ов. Это implicit-grant flow, токен
// возвращается в hash-фрагменте redirect URL.

export const YANDEX_MUSIC_CLIENT_ID = "23cabbbdc6cd418abb4b39c32c41195d";

export const OAUTH_AUTHORIZE_URL =
  `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YANDEX_MUSIC_CLIENT_ID}`;

const STORAGE_KEY = "ymd_oauth_token";

/**
 * Сохранённый токен. `null`, если расширение ещё не авторизовано.
 */
export async function getStoredToken(): Promise<string | null> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const value = (data as Record<string, unknown>)[STORAGE_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function setStoredToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: token });
}

export async function clearStoredToken(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
