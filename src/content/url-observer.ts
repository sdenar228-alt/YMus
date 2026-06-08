// Feature: yandex-music-downloader
// Requirements: 3.6
//
// Отслеживание изменений URL на странице SPA Яндекс Музыки.
// Поскольку SPA-навигация выполняется без перезагрузки страницы, для
// надёжного обнаружения смены URL патчатся методы `history.pushState` и
// `history.replaceState` (которые не инициируют стандартное событие
// `popstate`), а также подписка осуществляется на `popstate`, `hashchange`
// и кастомное событие `yandexmusic:locationchange`.

const LOCATION_CHANGE_EVENT = "yandexmusic:locationchange";

let historyPatched = false;

/**
 * Патчит методы `history.pushState` и `history.replaceState` так, чтобы
 * после оригинального вызова отправлялось кастомное событие
 * `yandexmusic:locationchange`. Патч применяется один раз на всё
 * время жизни страницы, повторные вызовы игнорируются.
 */
function patchHistoryMethods(): void {
  if (historyPatched) {
    return;
  }
  historyPatched = true;

  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = function patchedPushState(
    ...args: Parameters<typeof history.pushState>
  ): void {
    originalPushState(...args);
    window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
  };

  history.replaceState = function patchedReplaceState(
    ...args: Parameters<typeof history.replaceState>
  ): void {
    originalReplaceState(...args);
    window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
  };
}

/**
 * Подписывается на изменения URL страницы. При каждой смене `location.href`
 * вызывается `onURLChange` с новым URL.
 *
 * Источники событий:
 * - `popstate` — навигация назад/вперёд через историю браузера;
 * - `hashchange` — изменение хеш-части URL;
 * - `yandexmusic:locationchange` — кастомное событие, отправляемое из
 *   пропатченных `history.pushState` и `history.replaceState`.
 *
 * @param onURLChange Колбэк, вызываемый при изменении URL.
 */
export function observeURLChanges(
  onURLChange: (newURL: string) => void,
): void {
  patchHistoryMethods();

  let lastURL = location.href;

  const handleLocationChange = (): void => {
    const currentURL = location.href;
    if (currentURL !== lastURL) {
      lastURL = currentURL;
      onURLChange(currentURL);
    }
  };

  window.addEventListener("popstate", handleLocationChange);
  window.addEventListener("hashchange", handleLocationChange);
  window.addEventListener(LOCATION_CHANGE_EVENT, handleLocationChange);
}
