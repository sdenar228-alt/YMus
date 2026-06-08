/**
 * Logger for the yandex-music-downloader extension.
 *
 * Service Worker никогда не бросает необработанное исключение наружу.
 * Все ошибки логируются через `console.error` с префиксом
 * `[yandex-music-downloader]` и компонентом-источником.
 *
 * Requirements: 7.5
 */

/**
 * Logs an error to `console.error` with a tagged prefix identifying both
 * the extension and the component that produced the error.
 *
 * @param component - Name of the component that produced the error (e.g. "SW", "api-client").
 * @param error - The error value. Accepts `unknown` so callers can forward
 *                values from `catch` blocks without narrowing first.
 */
export function logError(component: string, error: unknown): void {
  console.error(`[yandex-music-downloader][${component}]`, error);
}
