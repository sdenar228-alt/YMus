// Feature: yandex-music-downloader
// Requirements: 3.5
//
// Наблюдение за появлением контейнера плеера в SPA Яндекс Музыки.
//
// DOM Яндекс Музыки регулярно меняется, поэтому используется список
// селекторов-кандидатов. Возвращаем первый найденный.

const PLAYER_CONTAINER_SELECTORS: readonly string[] = [
  // Старые классы (на всякий случай)
  ".player-controls__track-controls",
  ".player-controls",
  // Современные классы 2024+
  '[class*="PlayerBarDesktop"]',
  '[class*="PlayerBar_root"]',
  '[class*="Player_root"]',
  '[class*="PlayerControls"]',
  '[class*="player-bar"]',
  // Аудио-плеер по data-test атрибуту
  '[data-test="player-bar"]',
  '[data-test-id*="player"]',
  // Footer как последний фолбэк (плеер обычно внизу)
  "footer",
];

const MAX_DURATION_MS = 15000;

/**
 * Ищет контейнер плеера среди списка селекторов.
 * Возвращает первый найденный элемент или null.
 */
function findPlayerContainer(): Element | null {
  for (const selector of PLAYER_CONTAINER_SELECTORS) {
    try {
      const el = document.querySelector(selector);
      if (el !== null) {
        return el;
      }
    } catch {
      // Невалидный селектор — пропускаем.
    }
  }
  return null;
}

/**
 * Наблюдает за DOM до появления контейнера плеера и вызывает
 * `onContainerFound` ровно один раз с найденным элементом.
 *
 * Если контейнер не появился за 15 секунд, наблюдение прекращается.
 */
export function observePlayerContainer(
  onContainerFound: (el: Element) => void,
): void {
  const existing = findPlayerContainer();
  if (existing !== null) {
    onContainerFound(existing);
    return;
  }

  let finished = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const observer = new MutationObserver(() => {
    if (finished) return;

    const el = findPlayerContainer();
    if (el !== null) {
      stop();
      onContainerFound(el);
    }
  });

  function stop(): void {
    if (finished) return;
    finished = true;
    observer.disconnect();
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  timeoutId = setTimeout(stop, MAX_DURATION_MS);
  observer.observe(document.body, { childList: true, subtree: true });
}
