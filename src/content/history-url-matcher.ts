/**
 * Проверяет, является ли pathname страницей истории прослушиваний.
 * Паттерны:
 *   - /music-history (новый URL)
 *   - /users/{non-empty-login}/history (legacy URL)
 */
export function isHistoryPage(pathname: string): boolean {
  if (pathname === "/music-history") return true;
  return /^\/users\/[^/]+\/history$/.test(pathname);
}
